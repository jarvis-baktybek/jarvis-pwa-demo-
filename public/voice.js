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

  const WAIT_SILENCE_MS = 810;
  const MIN_VOICE_MS = 390;
  const MAX_UTTERANCE_MS = 16_000;
  const VOICE_THRESHOLD = .115;
  const INTERRUPT_THRESHOLD = .25;
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
  let bargeSince = 0;
  let initPromise = Promise.resolve();
  let controller = null;
  let turnCounter = 0;
  let playingBlocked = false;
  let endAfterAudio = false;
  let pendingAudioId = '';

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
    recorderStarted=performance.now();voiceSince=0;lastVoiceAt=0;
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
    sessionId=crypto.randomUUID();turnCounter++;
    set('listening','Разрешите доступ к микрофону');
    // Do not play a greeting: start the n8n session silently to avoid repetition.
    initPromise=request('/api/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'start',session_id:sessionId,text:''})}).catch(err=>{warn(err);return null;});
    try{
      activeMic=await UI.startMic();
      if(phase!=='listening')return;
      startRecorder();
      UI.setDetail('Слушаю Вас · касание сферы — отправить');
    }catch(err){warn(err);await end();}
  }
  async function submit(){
    if(phase!=='listening')return;
    const spoke=!!voiceSince && performance.now()-voiceSince>=MIN_VOICE_MS;
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
  async function playTicket(ticket){
    stopAudio();pendingAudioId=ticket;
    audio.src='/api/speech/'+encodeURIComponent(ticket);
    set('speaking','Коснитесь сферы, чтобы остановить ответ');
    try{await audio.play();playingBlocked=false;}
    catch{
      playingBlocked=true;
      UI.setDetail('Коснитесь сферы, чтобы включить звук');
    }
  }
  async function afterSpeech(){
    stopAudio();
    if(endAfterAudio){await end();return;}
    set('listening','Слушаю Вас · говорите свободно');
    startRecorder();
  }
  audio.addEventListener('ended',()=>{if(phase==='speaking')void afterSpeech();});
  audio.addEventListener('error',()=>{if(phase==='speaking' && !playingBlocked){UI.setDetail('Не удалось воспроизвести голос. Коснитесь сферы для повтора');}});
  function interrupt(){
    // We abort playback immediately and start a new utterance.
    stopAudio();bargeSince=0;turnCounter++;
    set('listening','Слушаю Вас');
    startRecorder();
  }
  async function tap(){
    if(phase==='idle')return start();
    if(phase==='listening')return submit();
    if(phase==='thinking'){
      turnCounter++;controller?.abort();controller=null;
      set('listening','Слушаю Вас');startRecorder();return;
    }
    if(phase==='speaking'){
      // Touch is a guaranteed stop command; do not interpret it as 'play' when Safari blocks audio.
      interrupt();
    }
  }
  async function end(){
    turnCounter++;controller?.abort();controller=null;
    stopAudio();disposeRecorder();activeMic=null;
    voiceSince=lastVoiceAt=bargeSince=0;
    set('idle');
    try{await UI.stopMic();}catch{}
  }
  function onMicLevel(level,ts){
    if(phase==='listening' && recorder?.state==='recording'){
      if(level>VOICE_THRESHOLD){
        if(!voiceSince)voiceSince=ts;
        lastVoiceAt=ts;
      }
      if(voiceSince && ts-voiceSince>MIN_VOICE_MS && ts-lastVoiceAt>WAIT_SILENCE_MS){
        void submit();return;
      }
      if(voiceSince && ts-voiceSince>MAX_UTTERANCE_MS){void submit();}
    }
    if(phase==='speaking' && !playingBlocked){
      // Conservative heuristic. Echo cancellation on Safari is not perfectly reliable.
      if(level>INTERRUPT_THRESHOLD){
        if(!bargeSince)bargeSince=ts;
        if(ts-bargeSince>260)interrupt();
      }else bargeSince=0;
    }
  }
  window.jarvisController={tap,end,onMicLevel};
})();
