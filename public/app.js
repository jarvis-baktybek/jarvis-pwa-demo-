/*
 * JARVIS PWA — waveform renderer connected to voice.js controller.
 * Microphone is visualized locally. Recording, STT and routing handled in voice.js.
 */
(() => {
  'use strict';
  const app = document.getElementById('app');
  const canvas = document.getElementById('orb-canvas');
  const button = document.getElementById('orb-control');
  const title = document.getElementById('state-title');
  const detail = document.getElementById('state-detail');
  const announcement = document.getElementById('live-announcement');
  const ctx = canvas.getContext('2d', {alpha: true, desynchronized: true});
  if (!ctx) return;

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  const CW = 600, CY = 300, CX = 300, R = 203;
  const TAU = Math.PI * 2;
  const TWO_PI = Math.PI * 2;
  const image = new Image();
  image.src = './assets/orb-texture.webp';

  let state = 'idle';
  let audioContext = null, micStream = null, analyzer = null, samples = null;
  let audioLevel = 0, smoothLevel = 0, peak = 0;
  let heardSpeech = false, speechBegan = 0, silenceSince = 0;
  let raf = 0, lastRenderAt = 0, dpr = 1;
  let pointerHeldTimer = null, wasLongPress = false, pointerHandled = false;
  let lastUpdateMs = performance.now();

  function rescale() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(CW * dpr);
    canvas.height = Math.round(CW * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  rescale();
  window.addEventListener('resize', rescale, {passive: true});

  const copy = {
    idle: ['JARVIS', 'Готов к запуску'],
    listening: ['Слушаю Вас', 'Говорите свободно · после паузы отвечу'],
    thinking: ['Обрабатываю запрос', 'Получаю ответ'],
    speaking: ['Джарвис отвечает', 'Коснитесь сферы, чтобы остановить']
  };

  function setState(next) {
    state = next;
    app.dataset.state = next;
    title.textContent = copy[next][0];
    detail.textContent = copy[next][1];
    announcement.textContent = copy[next][0];
    const aria = {
      idle: 'Начать разговор',
      listening: 'Отправить текущую реплику',
      thinking: 'Отменить ожидание',
      speaking: 'Прервать ответ Джарвиса'
    };
    button.setAttribute('aria-label', aria[next]);
    audioLevel = 0;
    heardSpeech = false;
    silenceSince = 0;
    speechBegan = 0;
  }

  function onTap() {
    if (window.jarvisController) void window.jarvisController.tap();
  }
  async function stopMic() {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    analyzer = null;
    samples = null;
    if (audioContext) {
      const old = audioContext;
      audioContext = null;
      try { await old.close(); } catch (_) { /* the demo must continue */ }
    }
  }
  function endSession(reason='manual') {
    if (window.jarvisController) void window.jarvisController.end(reason);
    setState('idle');
    void stopMic();
  }

  async function startMicrophoneVisualization() {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      // file:// preview still renders and cycles by tapping the sphere.
      throw new Error('Для микрофона необходимо HTTPS и разрешение браузера.');
    }
    try {
      // Create/resume the analyser before the first await. On a manual tap,
      // Safari's short-lived user activation can otherwise expire at the permission prompt.
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        audioContext = new Audio();
        if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
      }
      const stream = await navigator.mediaDevices.getUserMedia({audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }, video: false});
      if (state === 'idle') {
        stream.getTracks().forEach(t => t.stop());
        throw new Error('Сессия завершена.');
      }
      micStream = stream;
      if (!audioContext) return stream;
      if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
      const source = audioContext.createMediaStreamSource(stream);
      analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 1024;
      analyzer.smoothingTimeConstant = .80;
      // Band-limit *detection only* to human speech frequencies. The recording
      // stream remains untouched for OpenAI transcription.
      const highpass=audioContext.createBiquadFilter();
      highpass.type='highpass';highpass.frequency.value=165;highpass.Q.value=.707;
      const lowpass=audioContext.createBiquadFilter();
      lowpass.type='lowpass';lowpass.frequency.value=3800;lowpass.Q.value=.707;
      source.connect(highpass);highpass.connect(lowpass);lowpass.connect(analyzer);
      samples = new Uint8Array(analyzer.fftSize);
      if (state === 'listening') detail.textContent = 'Говорите свободно · после паузы отвечу';
      return stream;
    } catch (error) {
      await stopMic();
      throw error;
    }
  }
  async function ensureMicReady(){
    if (!audioContext) return Boolean(micStream?.active);
    if (audioContext.state==='running')return true;
    try {
      await Promise.race([
        audioContext.resume().catch(()=>{}),
        new Promise(resolve=>setTimeout(resolve,900))
      ]);
    }catch{}
    return audioContext.state==='running';
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    wasLongPress = false;
    pointerHandled = state === 'speaking' || state === 'thinking';
    // Stop playback immediately on touch-down. Waiting for touch-up feels unresponsive.
    if (pointerHandled) onTap();
    window.clearTimeout(pointerHeldTimer);
    pointerHeldTimer = window.setTimeout(() => {
      wasLongPress = true;
      endSession();
      if (navigator.vibrate) navigator.vibrate(12);
    }, 850);
  }
  function onPointerUp() {
    window.clearTimeout(pointerHeldTimer);
    pointerHeldTimer = null;
    if (!wasLongPress && !pointerHandled) onTap();
    pointerHandled = false;
  }
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerUp);
  button.addEventListener('pointercancel', () => window.clearTimeout(pointerHeldTimer));
  button.addEventListener('contextmenu', e => e.preventDefault());
  button.addEventListener('keydown', e => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) onTap();
    }
    if (e.key === 'Escape') endSession();
  });

  function micEnvelope(timestamp) {
    if ((state !== 'listening' && state !== 'speaking') || !analyzer || !samples) return 0;
    analyzer.getByteTimeDomainData(samples);
    let energy = 0;
    for (let i = 0; i < samples.length; i += 3) {
      const delta = (samples[i] - 128) / 128;
      energy += delta * delta;
    }
    const level = Math.sqrt(energy / Math.ceil(samples.length / 3));
    // Sensitivity for a lively waveform while suppressing quiet mic noise.
    const envelope = Math.min(1, Math.max(0, level - .009) * 12);
    if (window.jarvisController?.onMicLevel) window.jarvisController.onMicLevel(envelope, timestamp, {rms:level});
    return envelope;
  }

  const stars = Array.from({length: 68}, (_,i) => {
    const a = i * 2.39996323, s = Math.sqrt((i+.5)/68);
    return {x: CX + Math.cos(a)*s*185, y: CY + Math.sin(a)*s*180,
      phase: (i*1.79) % TWO_PI, size: i % 6 === 0 ? 1.15 : .55};
  });
  function glowDot(x, y, rad, alpha, color='#87eaff') {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function drawBackdrop(t, intensity) {
    let g = ctx.createRadialGradient(CX,CY,145,CX,CY,288);
    g.addColorStop(0, 'rgba(2,147,250,.00)');
    g.addColorStop(.48, `rgba(4,101,215,${.08+.05*intensity})`);
    g.addColorStop(1, 'rgba(3,52,135,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX,CY,294,0,TAU); ctx.fill();

    for (let j=0; j<3; j++) {
      ctx.save();
      ctx.translate(CX,CY);
      ctx.rotate(.06 * Math.sin(t*.12+j*2));
      ctx.beginPath();
      ctx.ellipse(0, 0, 253+j*19, 235+j*21, -.12+j*.08, 0, TAU);
      ctx.strokeStyle = j===0 ? 'rgba(29,174,255,.23)' : 'rgba(43,131,218,.105)';
      ctx.lineWidth = j===0 ? .75 : .55;
      ctx.stroke();
      ctx.restore();
    }
    // Rotating arcs and orbiting light particles, no CSS fake looping.
    for (let j=0; j<4; j++) {
      const rate = (state === 'thinking' ? .65 : .16) * (j%2===0?1:-1);
      const start = t*rate + j*1.45;
      const radius = 250 + (j%3)*20;
      const len = .20 + .14 * Math.sin(t*.4+j)**2;
      const grad = ctx.createLinearGradient(CX-radius,CY,CX+radius,CY);
      grad.addColorStop(0,'rgba(45,154,255,0)');
      grad.addColorStop(.5,`rgba(71,207,255,${.45 + intensity*.15})`);
      grad.addColorStop(1,'rgba(154,85,255,0)');
      ctx.save();
      ctx.beginPath(); ctx.arc(CX,CY,radius,start,start+len);
      ctx.strokeStyle = grad; ctx.lineWidth = j===0 ? 1.65 : 1;
      ctx.shadowBlur = j===0 ? 13 : 6;
      ctx.shadowColor = '#07a8f9';ctx.stroke();ctx.restore();
      glowDot(CX+radius*Math.cos(start+len),CY+radius*Math.sin(start+len), j===0?1.6:.7, .37+intensity*.18);
    }
  }

  function orbMask() {
    ctx.beginPath(); ctx.arc(CX,CY,R,0,TAU);
  }
  function waveY(x,t,shift,amount) {
    const x0 = (x-CX)/75;
    const roll = state === 'thinking' ? 1.55 : state === 'speaking' ? 1.65 : .77;
    return 313 + shift + amount * (
      .57 * Math.sin(x0*1.18-t*roll+shift*.035)
       + .37 * Math.sin(x0*2.05 + t*.82 + shift*.1)
       + .20 * Math.sin(x0*.55 + t*.53)
    );
  }
  function drawRibbon(t, n, activity) {
    const offs = [-36,-18,-3,15,31];
    const shift = offs[n] + 6*Math.sin(t*.22+n);
    const amount = 27 + activity*37 + n*1.2;
    const thickness = 11 + activity*8 + (n===2?5:0);
    const grad = ctx.createLinearGradient(95,250,510,370);
    grad.addColorStop(0,'rgba(0,195,255,0)');
    grad.addColorStop(.15,'rgba(2,203,255,.19)');
    grad.addColorStop(.46,'rgba(20,195,250,.23)');
    grad.addColorStop(.70,'rgba(108,132,255,.24)');
    grad.addColorStop(.91,'rgba(173,73,245,.22)');
    grad.addColorStop(1,'rgba(186,83,255,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.beginPath();
    for(let x=80; x<=520; x+=7) {
      const y=waveY(x,t,shift,amount)-thickness;
      if (x===80) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    for(let x=520; x>=80; x-=7) ctx.lineTo(x,waveY(x,t,shift,amount)+thickness);
    ctx.closePath();ctx.fill();

    // Highlight strand with an intense electric-blue to violet color blend.
    const stroke = ctx.createLinearGradient(108,280,492,335);
    stroke.addColorStop(0,'rgba(31,242,255,0)');
    stroke.addColorStop(.17,'rgba(31,234,255,.74)');
    stroke.addColorStop(.44,'rgba(114,245,255,.92)');
    stroke.addColorStop(.68,'rgba(112,151,255,.72)');
    stroke.addColorStop(.86,'rgba(212,131,255,.82)');
    stroke.addColorStop(1,'rgba(198,94,255,0)');
    ctx.beginPath();
    for(let x=80; x<=520; x+=6) {
      const y=waveY(x,t,shift,amount);
      if(x===80)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.lineWidth = n===2?2.15:1.0;
    ctx.strokeStyle=stroke;
    ctx.shadowColor = n<3?'#08dcff':'#b75cff';
    ctx.shadowBlur = n===2 ? 20 : 13;
    ctx.globalAlpha = n===2?.83:.34;
    ctx.stroke();ctx.restore();
  }
  function drawSphere(t,activity) {
    ctx.save();
    ctx.shadowColor = state === 'speaking' ? '#1cbdff' : '#0089ff';
    ctx.shadowBlur = 45 + activity*27;
    ctx.fillStyle = 'rgba(12,62,169,.90)';
    orbMask(); ctx.fill(); ctx.restore();

    ctx.save(); orbMask(); ctx.clip();
    const base = ctx.createRadialGradient(250,218,20, CX,CY,300);
    base.addColorStop(0,'#103d86');base.addColorStop(.32,'#071b49');
    base.addColorStop(.62,'#06173f');base.addColorStop(.89,'#080f30');base.addColorStop(1,'#101049');
    ctx.fillStyle = base;ctx.fillRect(90,90,420,420);
    if (image.complete && image.naturalWidth) {
      ctx.globalAlpha=.73;
      ctx.drawImage(image,CX-R,CY-R,2*R,2*R);
      ctx.globalAlpha=1;
    }
    // Volumetric light with a different frequency for each state.
    const light = ctx.createRadialGradient(210+25*Math.sin(t*.3),230,4,270,298,200);
    light.addColorStop(0,`rgba(21,130,249,${.12 + activity*.09})`);
    light.addColorStop(.5,'rgba(26,82,188,.05)');light.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=light;ctx.fillRect(90,90,420,420);
    const purple = ctx.createRadialGradient(451,405,6,390,391,180);
    purple.addColorStop(0,`rgba(183,40,237,${.19+activity*.12})`);
    purple.addColorStop(.67,'rgba(70,26,186,.045)');purple.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=purple;ctx.fillRect(90,90,420,420);

    // Faint volumetric filaments, never static orbit illusion.
    for(let i=0; i<5; i++) drawRibbon(t+i*.05,i,activity);
    for (const s of stars) {
      const twinkle = Math.max(0, Math.sin(t*(.65+s.size*.2)+s.phase));
      glowDot(s.x+2*Math.sin(t*.22+s.phase),s.y,s.size, (.08+twinkle*.20)*(1+activity*.50));
    }
    // Shadows near the bottom and transparent glass highlight at top.
    let shade = ctx.createLinearGradient(300,110,300,490);
    shade.addColorStop(0,'rgba(5,11,30,.03)');shade.addColorStop(.43,'rgba(0,0,0,0)');shade.addColorStop(1,'rgba(2,8,30,.17)');
    ctx.fillStyle=shade;ctx.fillRect(95,95,410,410);
    ctx.restore();

    const rim = ctx.createLinearGradient(112,130,484,460);
    rim.addColorStop(0,'rgba(18,130,255,.25)');
    rim.addColorStop(.2,'rgba(72,214,255,.96)');
    rim.addColorStop(.4,'rgba(96,235,255,.96)');
    rim.addColorStop(.66,'rgba(60,164,255,.70)');
    rim.addColorStop(.86,'rgba(168,118,255,.94)');
    rim.addColorStop(1,'rgba(34,147,255,.42)');
    ctx.save();ctx.shadowBlur=18+activity*9;ctx.shadowColor='#13b5ff';
    orbMask();ctx.strokeStyle=rim;ctx.lineWidth=2.1;ctx.stroke();ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(190,241,255,.17)';ctx.lineWidth=1;
    ctx.beginPath();ctx.arc(CX,CY,R-6,Math.PI*1.22,Math.PI*1.88);ctx.stroke();ctx.restore();
    const aura = ctx.createRadialGradient(CX,CY,197,CX,CY,260);
    aura.addColorStop(0,`rgba(9,133,240,${.12+activity*.06})`);
    aura.addColorStop(1,'rgba(0,80,140,0)');
    ctx.fillStyle=aura;orbMask();ctx.fill();
  }
  function render(timestamp) {
    raf = requestAnimationFrame(render);
    const frameInterval = reducedMotion ? 150 : (window.innerWidth < 600 ? 1000/45 : 1000/55);
    if (timestamp - lastRenderAt < frameInterval) return;
    lastRenderAt=timestamp;
    const t = reducedMotion ? 1 : timestamp/1000;
    const mic = micEnvelope(timestamp);
    const response = state==='speaking' ? .44+.32*Math.sin(t*5.3)**2+.17*Math.sin(t*10.8)**2 : 0;
    const thinking=state==='thinking'?.4+.14*Math.sin(t*2)**2:0;
    const target = Math.min(1, Math.max(mic,response,thinking));
    smoothLevel += (target - smoothLevel)*(target>smoothLevel?.28:.08);
    peak += ((state==='idle'?.08:.14) + smoothLevel*.8 - peak)*.08;
    ctx.clearRect(0,0,CW,CW);
    drawBackdrop(t,smoothLevel);
    drawSphere(t,Math.max(peak,smoothLevel));
    lastUpdateMs=timestamp;
  }
  window.JARVIS_UI = {setTitle:v=>{title.textContent=v;announcement.textContent=v},setState, startMic:startMicrophoneVisualization, ensureMicReady, stopMic, endSession, getState:()=>state, setDetail:v=>{detail.textContent=v}, onError:v=>{title.textContent='Не удалось подключиться';detail.textContent=v}};
  raf=requestAnimationFrame(render);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf=0;
      // The visual demo should not keep a microphone active when not visible.
      endSession('background');
    } else {
      if (!raf) raf=requestAnimationFrame(render);
      window.jarvisController?.onVisible?.();
    }
  });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
