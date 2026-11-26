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

  // Tap Start 0.7.3: explicit gesture starts speech, not page load.
  // iPhone blocks unprompted autoplay, so never try to play on launch.
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
  let greetingActive = false;
  let microphoneStarting = false;
  let blockedWelcomeNeedsTap = false;
  let cachedWelcomeAttempt = false;
  let greetingFallbackPending = false;

  async function request(url,options={}) {
    const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);
    return data;
  }
  async function status(){try{
      const d=await request('/api/status');authorized=d.authorized;demo=d.demo;
      if(!authorized){overlay.hidden=false;}else{overlay.hidden=true;set('idle','Коснитесь сферы, чтобы запустить Джарвиса');}
      if(!d.ready && !demo)UI.setDetail('Сначала настройте сервер: ключи OpenAI, n8n и ElevenLabs');
    }catch{UI.setDetail('Подключитесь к серверу JARVIS через HTTPS');}
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    authError.textContent='';
    try{
      await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:pin.value})});
      pin.value='';authorized=true;overlay.hidden=true;
      set('idle','Коснитесь сферы, чтобы запустить Джарвиса');
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
  function stopAudio(){
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
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
  // Tap Start 0.7.3: no microphone access, recording or "Слушаю" state
  // until the greeting has finished. A blocked iOS autoplay stays idle rather
  // than silently opening the microphone and pretending the voice played.
  async function openMicAfterGreeting(){
    if(phase!=='speaking' || microphoneStarting)return;
    const generation=turnCounter;
    greetingActive=false;
    microphoneStarting=true;
    set('thinking','Включаю микрофон');
    UI.setTitle?.('Подключаю микрофон');
    try{
      activeMic=await UI.startMic();
      if(generation!==turnCounter || phase!=='thinking'){
        await UI.stopMic();activeMic=null;return;
      }
      if(UI.ensureMicReady && !(await UI.ensureMicReady())){
        await UI.stopMic();activeMic=null;
        set('idle','iPhone требует касание сферы для включения микрофона');
        return;
      }
      if(generation!==turnCounter || phase!=='thinking')return;
      set('listening','Слушаю Вас');
      startRecorder();
    }catch(err){
      if(generation!==turnCounter)return;
      await UI.stopMic().catch(()=>{});activeMic=null;
      set('idle','Не удалось включить микрофон · коснитесь сферы');
    }finally{
      microphoneStarting=false;
    }
  }
  async function start(){
    if(!authorized){overlay.hidden=false;return;}
    if(phase!=='idle')return;
    if(!window.isSecureContext){warn(new Error('Нужен HTTPS для микрофона на iPhone'));return;}
    if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){warn(new Error('Браузер не поддерживает запись речи'));return;}
    // Prime the analyzer's AudioContext inside the user's tap gesture.
    // This does NOT capture any microphone audio before the greeting.
    UI.prepareMicAudio?.();
    sessionId=crypto.randomUUID();turnCounter++;
    const generation=turnCounter;
    endAfterAudio=false;
    greetingActive=true;
    blockedWelcomeNeedsTap=false;
    // A manual tap launches the fixed, pre-generated ElevenLabs greeting first.
    set('speaking','Джарвис на связи');
    UI.setTitle?.('Джарвис на связи');
    // Initialize n8n concurrently with the greeting, not before playback.
    // submit() awaits this same promise, so the first CRM question still has a
    // fully initialized session. Mark rejection handled until submit awaits it.
    initPromise=request('/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'start',session_id:sessionId,text:''})});
    void initPromise.catch(()=>{});
    try{
      if(demo){
        await initPromise;
        if(generation===turnCounter && phase==='speaking')await openMicAfterGreeting();
        return;
      }
      cachedWelcomeAttempt=true;
      audio.src='/api/welcome-audio?v=0.7.2';
      // Do not await the remote n8n setup before starting the voice.
      try{
        await audio.play();
        cachedWelcomeAttempt=false;
        playingBlocked=false;
      }catch(playError){
        cachedWelcomeAttempt=false;
        if(generation!==turnCounter || phase!=='speaking' || !greetingActive)return;
        if(playError?.name==='NotAllowedError'){
          // Safari disallows autoplay: one sphere tap will retry the very same sound.
          playingBlocked=true;
          blockedWelcomeNeedsTap=true;
          greetingActive=false;
          set('idle','Не удалось включить приветствие · коснитесь сферы ещё раз');
          return;
        }
        // Offline, old server, or unsupported response: use the previous
        // proven ticket path instead of leaving the user without a greeting.
        // Ignore late media errors from the initial audio URL while switching.
        greetingFallbackPending=true;
        try{
          stopAudio();
          const hello=await initPromise;
          if(generation!==turnCounter || phase!=='speaking' || !greetingActive)return;
          if(hello?.speech_ticket)await playTicket(hello.speech_ticket,{introduction:true});
          else{greetingActive=false;set('idle','Не удалось получить приветствие · коснитесь сферы');}
        }finally{
          greetingFallbackPending=false;
        }
      }
    }catch(err){
      if(generation!==turnCounter)return;
      greetingActive=false;
      await end('failure');
      warn(err);
      UI.setDetail('Не удалось запустить сеанс · коснитесь сферы для повтора');
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
        await playTicket(d.speech_ticket);
      }else {set('listening','Ответ без озвучки · попробуйте ещё раз');startRecorder();}
    }catch(err){
      if(turn!==turnCounter || err.name==='AbortError')return;
      warn(err);set('listening','Повторите запрос или проверьте соединение');startRecorder();
    }
  }
  async function playTicket(ticket,{introduction=false}={}){
    stopAudio();pendingAudioId=ticket;
    audio.src='/api/speech/'+encodeURIComponent(ticket);
    set('speaking',introduction?'Джарвис на связи':'Коснитесь сферы, чтобы остановить ответ');
    if(introduction)UI.setTitle?.('Джарвис на связи');
    try{await audio.play();playingBlocked=false;return true;}
    catch{
      playingBlocked=true;
      if(introduction){
        // iOS may refuse playback without a user gesture. Never start listening
        // before the greeting, or falsely claim the microphone is active.
        greetingActive=false;
        blockedWelcomeNeedsTap=true;
        // Keep the media URL: a direct tap may be able to play the buffered welcome.
        set('idle','Не удалось включить звук · коснитесь сферы ещё раз');
      }else UI.setDetail('Коснитесь сферы, чтобы включить звук');
      return false;
    }
  }
  async function afterSpeech(){
    const wasGreeting=greetingActive;
    stopAudio();
    if(wasGreeting){await openMicAfterGreeting();return;}
    if(endAfterAudio){await end();return;}
    set('listening','Слушаю Вас · говорите свободно');
    startRecorder();
  }
  audio.addEventListener('ended',()=>{if(phase==='speaking')void afterSpeech();});
  audio.addEventListener('error',()=>{
    // Let play() reject first so start() can use its ticket fallback.
    if(cachedWelcomeAttempt || greetingFallbackPending)return;
    if(phase!=='speaking' || playingBlocked)return;
    if(greetingActive){
      greetingActive=false;
      stopAudio();
      set('idle','Не удалось воспроизвести приветствие · коснитесь сферы');
    }else UI.setDetail('Не удалось воспроизвести голос. Коснитесь сферы для повтора');
  });
  function interrupt(){
    const wasGreeting=greetingActive;
    // Touch interrupts the greeting or any following answer immediately.
    stopAudio();turnCounter++;
    if(wasGreeting){
      void openMicAfterGreeting();
      return;
    }
    set('listening','Слушаю Вас');
    startRecorder();
  }
  async function tap(){
    if(phase==='idle' && blockedWelcomeNeedsTap){
      // A direct gesture can unlock audio.play() on iPhone. Retry the
      // original greeting without recreating the n8n session.
      blockedWelcomeNeedsTap=false;
      greetingActive=true;
      set('speaking','Джарвис на связи');
      UI.setTitle?.('Джарвис на связи');
      try{
        await audio.play();
        playingBlocked=false;
      }catch{
        // Do not start listening silently: the user explicitly requested
        // "Джарвис на связи" before any microphone capture.
        greetingActive=false;
        blockedWelcomeNeedsTap=true;
        set('idle','Не удалось воспроизвести приветствие · проверьте звук');
      }
      return;
    }
    if(phase==='idle')return start();
    if(phase==='listening')return submit(true);
    if(phase==='thinking'){
      if(microphoneStarting)return;
      turnCounter++;controller?.abort();controller=null;
      set('listening','Слушаю Вас');startRecorder();return;
    }
    if(phase==='speaking'){
      // Touch is a guaranteed stop command; do not interpret it as 'play' when Safari blocks audio.
      interrupt();
    }
  }
  async function end(reason='manual'){
    turnCounter++;controller?.abort();controller=null;
    greetingActive=false;blockedWelcomeNeedsTap=false;
    stopAudio();disposeRecorder();activeMic=null;endAfterAudio=false;
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
  function onVisible(){
    // PWA opening or returning to foreground never starts the microphone or speech.
    if(authorized && phase==='idle' && !blockedWelcomeNeedsTap)
      UI.setDetail('Коснитесь сферы, чтобы запустить Джарвиса');
  }
  window.jarvisController={tap,end,onMicLevel,onVisible};
})();
