/**
 * JARVIS Voice Beta controller: real audio -> OpenAI STT -> existing GPT+n8n -> ElevenLabs stream.
 * Visual transcription NEVER rendered. Browser receives speech tickets, not CRM results.
 * Full-duplex spoken interruption is experimental in iOS Safari; touch interruption is reliable.
 */
(() => {
  'use strict';
  const UI = window.JARVIS_UI;
  const overlay = document.getElementById('access-overlay');
  const form = document.getElementById('access-form');
  const pin = document.getElementById('access-code');
  const authError = document.getElementById('access-error');
  const audio = document.getElementById('jarvis-audio');
  if (!UI || !audio) return;

  // Speech gate 0.6: use real voiced audio time, not 'time since first loud sample'.
  // These conservative defaults can be tuned after testing on a specific phone.
  const WAIT_SILENCE_MS = 1050;
  const MIN_VOICE_MS = 240;
  const MAX_UTTERANCE_MS = 16_000;
  const MIN_VOICE_RMS = .026;
  const NOISE_MULTIPLIER = 2.15;
  const NOISE_MARGIN = .005;
  const ONSET_GAP_MS = 230;
  const MANUAL_VOICE_MS = 110;

  let authorized = false;
  let demo = false;
  let phase = 'idle';
  let sessionId = '';
  let activeMic = null;
  let recorder = null;
  let recorderStarted = 0;
  let chunks = [];
  let voiceSince = 0;
  let lastVoiceAt = 0;
  let noiseFloor = .010;
  let voicedMs = 0;
  let recentVoiceMs = 0;
  let lastStrongAt = 0;
  let lastMicAt = 0;
  let peakRms = 0;

  let initPromise = Promise.resolve();
  let controller = null;
  let turnCounter = 0;
  let playingBlocked = false;
  let endAfterAudio = false;
  let pendingAudioId = '';
  let playbackWatchdog = null;
  let micSuspendedForSpeech = false;
  let resumingMic = false;
  // Welcome is presentation-only: the proven 0.6 microphone/session path stays intact.
  let welcomeActive = false;
  let welcomeTimer = null;

  async function request(url,options={}) {
    const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
    return data;
  }
  async function status(){try{
      const d=await request('/api/status');authorized=d.authorized;demo=d.demo;
      if(!authorized){overlay.hidden=false;}else{overlay.hidden=true;}
      if(!d.ready && !demo)UI.setDetail('Сначала настройте сервер: ключи OpenAI, n8n и ElevenLabs');
    }catch{UI.setDetail('Подключитесь к серверу JARVIS через HTTPS');}
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    authError.textContent='';
    try{
      await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:pin.value})});
      pin.value='';authorized=true;overlay.hidden=true;
      UI.setDetail('Коснитесь сферы, чтобы начать разговор');
    }catch(err){authError.textContent=err.message==='wrong_code'?'Неверный код доступа':'Не удалось войти: '+err.message;}
  });
  void status();

  function set(next,detail=''){
    phase=next;UI.setState(next);
    if(detail)UI.setDetail(detail);
  }
  function disposeRecorder(){
    const r=recorder;recorder=null;chunks=[];
    if(r&&r.state!=='inactive'){
      try{r.ondataavailable=null;r.onstop=null;r.onerror=null;r.stop();}catch{}
    }
  }
  function clearPlaybackWatchdog(){
    if(playbackWatchdog!==null){clearTimeout(playbackWatchdog);playbackWatchdog=null;}
  }
  function setAudioSession(type){
    // Supported on newer Safari releases; browsers without it simply ignore this.
    try{if(navigator.audioSession && 'type' in navigator.audioSession)navigator.audioSession.type=type;}catch{}
  }
  function showPlaybackFailure(message){
    if(phase!=='speaking'||welcomeActive||!pendingAudioId)return;
    clearPlaybackWatchdog();
    playingBlocked=true;
    UI.setDetail(message+' · коснитесь сферы для повтора');
  }
  function watchPlayback(ticket){
    clearPlaybackWatchdog();
    playbackWatchdog=setTimeout(()=>{
      if(phase!=='speaking'||pendingAudioId!==ticket||welcomeActive)return;
      // A fulfilled play() does not prove that Safari advanced the media clock.
      if(audio.error||audio.paused||audio.currentTime<0.1){
        showPlaybackFailure('Голос не начал воспроизводиться');
      }
    },4500);
  }
  async function suspendMicForSpeech(){
    // iOS can direct sound to the quiet receiver while capture is open.
    // Only switch once the utterance has been fully recorded and transcribed.
    if(!activeMic)return;
    micSuspendedForSpeech=true;
    try{await UI.stopMic();}catch{}
    activeMic=null;
  }
  async function resumeMicAfterSpeech(){
    if(resumingMic)return;
    if(!micSuspendedForSpeech){startRecorder();return;}
    const generation=turnCounter;
    resumingMic=true;
    setAudioSession('play-and-record');
    try{
      const stream=await UI.startMic();
      if(generation!==turnCounter||phase!=='listening'){
        try{await UI.stopMic();}catch{}
        return;
      }
      activeMic=stream;
      micSuspendedForSpeech=false;
      startRecorder();
    }catch(err){
      if(generation===turnCounter&&phase==='listening'){
        UI.setDetail('Не удалось снова включить микрофон. Завершите разговор и запустите заново');
        warn(err);
      }
    }finally{resumingMic=false;}
  }
  function stopAudio(){
    // Keep the SAME media element and its user-gesture activation on iOS.
    // Removing src and calling load() between clips can make a later asynchronous
    // audio.play() behave like a fresh autoplay attempt in installed PWAs.
    clearPlaybackWatchdog();
    audio.pause();
    playingBlocked=false;
    pendingAudioId='';
  }
  function startRecorder(){
    if(!activeMic||!activeMic.active || recorder)return;
    const formats=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg'];
    const mime=formats.find(t=>window.MediaRecorder?.isTypeSupported?.(t))||'';
    try{
      recorder=new MediaRecorder(activeMic,mime?{mimeType:mime}:undefined);
    }catch{set('listening','Браузер не поддерживает запись речи');return;}
    chunks=[];
    recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
    recorder.onerror=()=>{disposeRecorder();set('listening','Ошибка записи. Коснитесь сферы для повтора.');};
    recorderStarted=performance.now();
    voiceSince=0;lastVoiceAt=0;voicedMs=0;recentVoiceMs=0;
    lastStrongAt=0;lastMicAt=0;peakRms=0;

    recorder.start();
  }
  async function stopRecorder(){
    const r=recorder;recorder=null;
    if(!r)return null;
    if(r.state==='inactive')return null;
    const mime=r.mimeType||'audio/mp4';
    const blob=await new Promise(resolve=>{
      const timeout=setTimeout(()=>resolve(null),2000);
      r.onstop=()=>{clearTimeout(timeout);resolve(new Blob(chunks,{type:mime.split(';')[0]}));chunks=[];};
      try{r.stop();}catch{clearTimeout(timeout);resolve(null);}
    });
    return blob;
  }
  function warn(error){
    let message=String(error?.message||error);
    const dict={
      login_required:'Войдите в JARVIS ещё раз',
      n8n_not_configured:'Не настроено подключение n8n',
      stt_not_configured:'Не настроено распознавание речи',
      voice_not_configured:'Не настроена озвучка ElevenLabs',
      empty_text:'Речь не распознана. Повторите.',
      audio_too_short:'Говорите немного дольше',
      invalid_session_id:'Сессия недействительна. Перезапустите разговор.'
    };
    message=dict[message]||message.replace(/(Bearer|sk-)[a-zA-Z0-9_-]+/g,'[hidden]');
    UI.onError(message.slice(0,140));
  }
  async function start(){
    if(!authorized){overlay.hidden=false;return;}
    if(phase!=='idle')return;
    if(!window.isSecureContext){warn(new Error('Нужен HTTPS для микрофона на iPhone'));return;}
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){warn(new Error('Браузер не поддерживает запись речи'));return;}
    setAudioSession('play-and-record');
    endAfterAudio=false;micSuspendedForSpeech=false;
    sessionId=crypto.randomUUID();turnCounter++;
    const generation=turnCounter;
    set('listening','Разрешите доступ к микрофону');
    // This is the original Noise Guard 0.6 session initialization.
    initPromise=request('/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'start',session_id:sessionId,text:''})}).catch(err=>{warn(err);return null;});
    // Critical iPhone behaviour: request the microphone directly from the tap,
    // as in the proven 0.6 release. Recording begins as soon as it is ready.
    const micPromise=UI.startMic();
    // Welcome uses the existing cached ElevenLabs endpoint. Failure or a missed
    // 'ended' event MUST NOT prevent normal 0.6 voice recognition.
    if(!demo){
      welcomeActive=true;
      set('speaking','Джарвис на связи');
      audio.muted=false;
      audio.src='/api/welcome-audio';
      welcomeTimer=setTimeout(()=>{if(generation===turnCounter)finishWelcome()},6500);
      try{
        const playing=audio.play();
        if(playing?.catch)void playing.catch(()=>{if(generation===turnCounter)finishWelcome()});
      }catch{finishWelcome();}
    }
    try{
      activeMic=await micPromise;
      if(generation!==turnCounter || phase==='idle')return;
      // Keep the original 0.6 MediaRecorder start behaviour. During the short
      // greeting onMicLevel is gated by phase='speaking', so no echo is sent.
      startRecorder();
      if(!welcomeActive)UI.setDetail('Слушаю Вас · касание сферы — отправить');
    }catch(err){
      if(generation!==turnCounter)return;
      warn(err);await end();
    }
  }
  function finishWelcome(){
    if(!welcomeActive)return;
    welcomeActive=false;
    if(welcomeTimer!==null){clearTimeout(welcomeTimer);welcomeTimer=null;}
    stopAudio();
    if(phase==='idle')return;
    // Discard any audio captured while the assistant spoke, without stopping
    // the microphone stream or requesting permission a second time.
    disposeRecorder();
    set('listening','Слушаю Вас · говорите свободно');
    if(activeMic){
      startRecorder();
      void UI.resumeMicContext?.();
    }
  }
  async function submit(manual=false){
    if(phase!=='listening')return;
    // A tap may intentionally submit a very short reply such as 'Да'.
    // Automatic submission requires a sustained, confirmed voiced region.
    const spoke=(!!voiceSince && voicedMs>=MIN_VOICE_MS) ||
      (manual && voicedMs>=MANUAL_VOICE_MS && peakRms>=MIN_VOICE_RMS);
    set('thinking','Распознаю Ваш голос');
    const turn=++turnCounter;
    const blob=await stopRecorder();
    if(turn!==turnCounter||phase!=='thinking')return;
    if(!blob||blob.size<1200||!spoke){
      set('listening','Не расслышал. Повторите, пожалуйста.');startRecorder();return;
    }
    controller=new AbortController();
    try{
      const textData=await request('/api/transcribe',{method:'POST',headers:{'Content-Type':blob.type||'audio/mp4'},body:blob,signal:controller.signal});
      if(turn!==turnCounter)return;
      if(!textData.text?.trim()) {set('listening','Не расслышал. Повторите, пожалуйста.');startRecorder();return;}
      UI.setDetail('Джарвис обрабатывает запрос');
      if(!(await initPromise))throw new Error('n8n_session_not_started');
      const d=await request('/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'ask',session_id:sessionId,text:textData.text}),signal:controller.signal});
      if(turn!==turnCounter)return;
      endAfterAudio=!!d.end_session;
      if(d.demo){
        set('speaking','Демонстрация интерфейса без реального голоса');
        setTimeout(()=>{if(turn===turnCounter)void afterSpeech()},2000);
      }else if(d.speech_ticket){
        pendingAudioId=d.speech_ticket;
        await suspendMicForSpeech();
        if(turn!==turnCounter)return;
        await playTicket(d.speech_ticket);
      }else {set('listening','Ответ без озвучки · попробуйте ещё раз');await resumeMicAfterSpeech();}
    }catch(err){
      if(turn!==turnCounter || err.name==='AbortError')return;
      warn(err);set('listening','Повторите запрос или проверьте соединение');await resumeMicAfterSpeech();
    }
  }
  async function playTicket(ticket){
    // Reuse the audio element that already played the greeting on a real tap.
    // Do not unload/reset it: Safari sometimes treats that as a fresh autoplay.
    clearPlaybackWatchdog();
    audio.pause();
    setAudioSession('playback');
    pendingAudioId=ticket;
    playingBlocked=false;
    audio.muted=false;
    audio.src='/api/speech/'+encodeURIComponent(ticket);
    set('speaking','Коснитесь сферы, чтобы остановить ответ');
    try{
      watchPlayback(ticket);
      await audio.play();
      if(phase==='speaking' && pendingAudioId===ticket)playingBlocked=false;
    }catch(err){
      if(phase!=='speaking' || pendingAudioId!==ticket)return;
      showPlaybackFailure('iPhone не воспроизвёл ответ: '+(err?.name||'ошибка плеера'));
    }
  }
  function retryBlockedReply(){
    // Must be invoked SYNCHRONOUSLY from the user's touch/pointer event.
    if(phase!=='speaking' || !playingBlocked || !pendingAudioId)return;
    const ticket=pendingAudioId;
    playingBlocked=false;
    UI.setDetail('Включаю голосовой ответ');
    setAudioSession('playback');
    watchPlayback(ticket);
    try{
      const play=audio.play();
      if(play?.catch)void play.catch(()=>{
        if(phase==='speaking' && pendingAudioId===ticket){
          playingBlocked=true;
          UI.setDetail('Не удалось включить голос. Проверьте звук iPhone и коснитесь ещё раз');
        }
      });
    }catch{
      playingBlocked=true;
      UI.setDetail('Не удалось включить голос. Проверьте звук iPhone и коснитесь ещё раз');
    }
  }
  async function afterSpeech(){
    stopAudio();
    if(endAfterAudio){await end();return;}
    set('listening','Слушаю Вас · говорите свободно');
    await resumeMicAfterSpeech();
  }
  audio.addEventListener('ended',()=>{if(welcomeActive){finishWelcome();return;}if(phase==='speaking')void afterSpeech();});
  audio.addEventListener('error',()=>{if(welcomeActive){finishWelcome();return;}if(phase==='speaking'){
    showPlaybackFailure('Ошибка загрузки голоса (медиа '+(audio.error?.code||'?')+')');
  }});
  audio.addEventListener('stalled',()=>{
    if(phase==='speaking'&&!welcomeActive&&audio.currentTime<0.1)
      UI.setDetail('Загрузка голоса задерживается. Если звука нет — коснитесь сферы');
  });
  function interrupt(){
    // We abort playback immediately and start a new utterance.
    stopAudio();turnCounter++;
    set('listening','Слушаю Вас');
    void resumeMicAfterSpeech();
  }
  async function tap(){
    if(phase==='idle')return start();
    if(welcomeActive){finishWelcome();return;}
    if(phase==='listening')return submit(true);
    if(phase==='thinking'){
      turnCounter++;controller?.abort();controller=null;
      set('listening','Слушаю Вас');void resumeMicAfterSpeech();return;
    }
    if(phase==='speaking'){
      // Normal touch interrupts speech; only a Safari-blocked reply needs a
      // deliberate one-tap playback retry, otherwise the user hears nothing.
      if(playingBlocked){retryBlockedReply();return;}
      interrupt();
    }
  }
  async function end(){
    turnCounter++;controller?.abort();controller=null;
    welcomeActive=false;
    if(welcomeTimer!==null){clearTimeout(welcomeTimer);welcomeTimer=null;}
    stopAudio();disposeRecorder();activeMic=null;micSuspendedForSpeech=false;resumingMic=false;
    voiceSince=lastVoiceAt=voicedMs=recentVoiceMs=lastStrongAt=lastMicAt=peakRms=0;
    set('idle');
    try{await UI.stopMic();}catch{}
  }
  function onMicLevel(level,ts,meta){
    // The moving sphere uses 'level'; speech recognition uses actual (band-limited)
    // microphone RMS, to avoid mistaking tiny clicks for a voice command.
    if(phase!=='listening' || recorder?.state!=='recording')return;
    const rms=Number.isFinite(meta?.rms) ? meta.rms : Math.max(0,level/12+.009);
    if(!Number.isFinite(rms) || rms<0)return;
    const dt=lastMicAt ? Math.max(0,Math.min(80,ts-lastMicAt)) : 0;
    lastMicAt=ts;
    const startGate=Math.max(MIN_VOICE_RMS,noiseFloor*NOISE_MULTIPLIER+NOISE_MARGIN);
    const keepGate=Math.max(.018,startGate*.69);
    const active=rms>=(voiceSince?keepGate:startGate);
    // Track quiet background only. Do not learn the user's voice as the noise floor.
    if(!voiceSince && rms<startGate*.80){
      noiseFloor=Math.max(.006,Math.min(.05,noiseFloor*.988+rms*.012));
    }
    if(active){
      if(ts-lastStrongAt>ONSET_GAP_MS)recentVoiceMs=0;
      recentVoiceMs+=dt;
      voicedMs+=dt;
      peakRms=Math.max(peakRms,rms);
      lastStrongAt=ts;
      if(!voiceSince && recentVoiceMs>=MIN_VOICE_MS){
        voiceSince=ts-recentVoiceMs;
      }
      if(voiceSince)lastVoiceAt=ts;
    }else if(!voiceSince && ts-lastStrongAt>ONSET_GAP_MS){
      recentVoiceMs=0;
    }
    if(voiceSince && ts-lastVoiceAt>=WAIT_SILENCE_MS){
      void submit();
    }else if(voiceSince && ts-voiceSince>=MAX_UTTERANCE_MS){
      void submit();
    }
    // Intentionally no audio-level interruption while JARVIS speaks: on iPhone,
    // loud background sounds and the assistant's own speaker cause false barge-ins.
    // Touching the sphere still stops playback immediately and opens the mic.
  }
  window.jarvisController={tap,end,onMicLevel};
})();
