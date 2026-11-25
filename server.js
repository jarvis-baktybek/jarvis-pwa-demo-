/**
 * JARVIS PWA — minimal Node 20+ secure same-origin backend.
 * Intelligence: existing n8n Dialog webhook (GPT), NOT ElevenLabs Agents.
 * STT: OpenAI /audio/transcriptions. TTS: ElevenLabs /stream.
 * This demo is single tenant. Credentials never enter the browser bundle.
 * No request/audio/transcript logs. No transcript persistence.
 */
import {createServer} from 'node:http';
import {readFileSync, existsSync, createReadStream, statSync} from 'node:fs';
import {resolve, extname, sep} from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';

const root = resolve(process.cwd(), 'public');
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v=m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"')) || (v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
      process.env[m[1]]=v;
    }
  }
}
const env = process.env;
const PORT = Number(env.PORT || 3000);
const demo = env.DEMO_MODE === 'true';
const accessCode = String(env.JARVIS_ACCESS_CODE || '');
const cred = name => {const value = env[name]; return Boolean(value && !/^(SET_|YOUR|https:\/\/YOUR)/i.test(value));};
const dialogConfigured = cred('N8N_DIALOG_URL') && cred('N8N_AUTH_HEADER_VALUE') && cred('N8N_AUTH_HEADER_NAME');
const sttConfigured = cred('OPENAI_API_KEY');
const voiceConfigured = cred('ELEVENLABS_API_KEY') && cred('ELEVENLABS_VOICE_ID');
if (!accessCode || accessCode.startsWith('SET_') || accessCode.length < 12) {
  console.error('JARVIS_ACCESS_CODE: установите длинный пароль (от 12 символов) в .env / environment.');
  process.exit(1);
}
if (!demo && (!dialogConfigured || !sttConfigured || !voiceConfigured)) {
  console.warn('Не все интеграции настроены. Проверьте переменные N8N_*, OPENAI_API_KEY, ELEVENLABS_* .');
}
if (dialogConfigured) {
  try {
    const u = new URL(env.N8N_DIALOG_URL);
    if (u.protocol !== 'https:' || !/\/webhook\/jarvis-dialog\/?$/.test(u.pathname)) throw new Error();
  } catch {
    console.error('Укажите корректный HTTPS URL вебхука jarvis-dialog'); process.exit(1);
  }
}

const sessions = new Map();
const tickets = new Map();
const authFails = new Map();
const TTL = 12*60*60*1000;
const now=()=>Date.now();
const token=()=>randomBytes(32).toString('base64url');
function safeEq(a,b){const x=Buffer.from(String(a));const y=Buffer.from(String(b));return x.length===y.length && timingSafeEqual(x,y);}
function send(res, status, data, extra={}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});
  res.end(JSON.stringify(data));
}
function fail(res,status,code){send(res,status,{ok:false,error:code});}
function cookies(req){return Object.fromEntries((req.headers.cookie || '').split(';').map(x=>x.trim().split('=').slice(0,2)).filter(x=>x.length===2));}
function session(req){const id=cookies(req).jarvis_session;const s=id&&sessions.get(id);if(!s||s.expires<now())return null;return {id,s};}
function purge(){const t=now(); for(const [k,v] of sessions)if(v.expires<t)sessions.delete(k);for(const [k,v] of tickets)if(v.expires<t)tickets.delete(k);for(const [k,v] of authFails)if(v.expires<t)authFails.delete(k);}
function originAllowed(req){
  const o=req.headers.origin;
  if(!o)return true; // non-browser fetch; still requires session cookie + PIN
  try {const host=req.headers['x-forwarded-host']||req.headers.host;return new URL(o).host===host;}catch{return false;}
}
function ip(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim().slice(0,80);}
async function readBody(req,max=1024*1024){
 let size=0;const chunks=[];
 for await (const chunk of req){size+=chunk.length;if(size>max){const e=new Error('file_too_large');e.code=413;throw e;}chunks.push(chunk);}
 return Buffer.concat(chunks);
}
async function readJSON(req,max=32*1024){const b=await readBody(req,max);try{return JSON.parse(b.toString('utf8'));}catch{const e=new Error('bad_json');e.code=400;throw e;}}
function mockDialog(body) {
 if (body.mode === 'start') return {ok:true,speak:'Здравствуйте. Слушаю Вас.',end_session:false,requires_confirmation:false};
 if (/^(?:стоп|пока|выход)$/i.test(body.text||''))return {ok:true,speak:'До связи.',end_session:true,requires_confirmation:false};
 return {ok:true,speak:'Это демонстрационный режим. Голосовая интеграция с Битрикс24 ещё не включена.',end_session:false,requires_confirmation:false};
}
async function callN8n(body) {
 if (demo) return mockDialog(body);
 if (!dialogConfigured)throw new Error('n8n_not_configured');
 const r=await fetch(env.N8N_DIALOG_URL,{method:'POST',headers:{'Content-Type':'application/json',[env.N8N_AUTH_HEADER_NAME]:env.N8N_AUTH_HEADER_VALUE},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});
 if(!r.ok)throw new Error(`n8n_http_${r.status}`);
 const data=await r.json();
 if(typeof data?.speak!=='string')throw new Error('n8n_invalid_speak');
 return data;
}
async function transcribe(buffer,mime){
 if(demo)return 'Проверка демонстрационного режима';
 if(!sttConfigured)throw new Error('stt_not_configured');
 const suffix = mime.includes('mp4')?'m4a':mime.includes('webm')?'webm':mime.includes('ogg')?'ogg':mime.includes('wav')?'wav':'mp3';
 const form=new FormData();
 form.append('file',new Blob([buffer],{type:mime}),`utterance.${suffix}`);
 form.append('model',env.OPENAI_STT_MODEL||'gpt-4o-mini-transcribe');
 const r=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`},body:form,signal:AbortSignal.timeout(50_000)});
 if(!r.ok)throw new Error(`stt_http_${r.status}`);
 const j=await r.json();
 if(typeof j?.text!=='string')throw new Error('stt_invalid_result');
 return j.text.trim().slice(0,2000);
}
function staticFile(req,res,path){
 const candidate=resolve(root, '.'+path);
 if(candidate!==root && !candidate.startsWith(root+sep))return fail(res,403,'forbidden');
 if(!existsSync(candidate)||!statSync(candidate).isFile())return fail(res,404,'not_found');
 const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'}[extname(candidate)]||'application/octet-stream';
 res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Cache-Control':extname(candidate)==='.html'?'no-store':'public,max-age=3600'});
 createReadStream(candidate).pipe(res);
}

async function handle(req,res){
 purge();
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Permissions-Policy','microphone=(self)');
 res.setHeader('X-Content-Type-Options','nosniff');
 const url=new URL(req.url,'http://localhost');const path=url.pathname;
 if(req.method==='GET' && path==='/health'){return send(res,200,{ok:true,service:'JARVIS Voice Beta'});}
 if(req.method==='GET' && path==='/api/status')return send(res,200,{ok:true,authorized:!!session(req),demo,ready:demo||(dialogConfigured&&sttConfigured&&voiceConfigured),tenant:env.JARVIS_TENANT_ID||'jarvis-demo'});
 if(path.startsWith('/api/') && !originAllowed(req))return fail(res,403,'cross_origin_rejected');
 if(req.method==='POST'&&path==='/api/login'){
   const k=ip(req),v=authFails.get(k)||{n:0,expires:now()+15*60*1000};
   if(v.n>=8&&v.expires>now())return fail(res,429,'too_many_attempts');
   const {code}=await readJSON(req);
   if(!safeEq(code,accessCode)) {v.n++;authFails.set(k,v);return fail(res,401,'wrong_code');}
   authFails.delete(k);const id=token();sessions.set(id,{expires:now()+TTL,tenant:env.JARVIS_TENANT_ID||'jarvis-demo'});
   const https=req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
   return send(res,200,{ok:true,authorized:true},{'Set-Cookie':`jarvis_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL/1000}${https?'; Secure':''}`});
 }
 const auth=session(req);
 if(path.startsWith('/api/') && !auth)return fail(res,401,'login_required');
 if(req.method==='POST'&&path==='/api/logout'){
   sessions.delete(auth.id);return send(res,200,{ok:true},{'Set-Cookie':'jarvis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
 }
 if(req.method==='POST'&&path==='/api/transcribe'){
   const mime=(req.headers['content-type']||'').split(';')[0].toLowerCase();
   if(!['audio/mp4','audio/webm','audio/ogg','audio/wav','audio/mpeg','audio/mp3'].includes(mime))return fail(res,415,'unsupported_audio_format');
   const buffer=await readBody(req,8*1024*1024);
   if(buffer.length<1200)return fail(res,400,'audio_too_short');
   const text=await transcribe(buffer,mime);
   return send(res,200,{ok:true,has_speech:text.length>0,text});
 }
 if(req.method==='POST'&&path==='/api/turn'){
   const b=await readJSON(req);
   const mode=b.mode==='start'?'start':'ask';
   const sid=String(b.session_id||'').trim();
   if(!/^[a-z0-9-]{12,90}$/i.test(sid))return fail(res,400,'invalid_session_id');
   const message=String(b.text||'').trim().slice(0,2000);
   if(mode==='ask'&&!message)return fail(res,400,'empty_text');
   const data=await callN8n({mode,device_id:'my-iphone',session_id:sid,text:message});
   let ticket=null;
   if(!demo && typeof data.speak==='string'&&data.speak.trim() && voiceConfigured){
     ticket=token(); tickets.set(ticket,{text:data.speak.trim().slice(0,1800),sid:auth.id,expires:now()+60_000});
   }
   // Do NOT expose any CRM payload, account identifiers or spoken transcript in response.
   return send(res,200,{ok:true,speech_ticket:ticket,end_session:data.end_session===true,requires_confirmation:data.requires_confirmation===true,has_speech:typeof data.speak==='string'&&!!data.speak.trim(),demo});
 }
 if(req.method==='GET'&&path.startsWith('/api/speech/')){
   const id=path.slice('/api/speech/'.length);
   const t=tickets.get(id); tickets.delete(id);
   if(!t||t.sid!==auth.id||t.expires<now())return fail(res,404,'ticket_expired');
   if(!voiceConfigured)return fail(res,503,'voice_not_configured');
   const voice=env.ELEVENLABS_VOICE_ID;
   const model=env.ELEVENLABS_MODEL_ID||'eleven_v4';
   const upstream=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`,{
      method:'POST',headers:{'xi-api-key':env.ELEVENLABS_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({text:t.text,model_id:model,language_code:'ru',apply_text_normalization:'on',voice_settings:{stability:.5,similarity_boost:.8}}),
      signal:AbortSignal.timeout(60_000)
   });
   if(!upstream.ok || !upstream.body)throw new Error(`elevenlabs_http_${upstream.status}`);
   res.writeHead(200,{'Content-Type':'audio/mpeg','Cache-Control':'no-store','Accept-Ranges':'none'});
   Readable.fromWeb(upstream.body).pipe(res);
   res.on('close',()=>{ if(!res.writableEnded) { try{upstream.body.cancel();}catch{} } });
   return;
 }
 if(req.method==='GET' && !path.startsWith('/api/'))return staticFile(req,res,path==='/'?'/index.html':path);
 return fail(res,404,'not_found');
}
const server=createServer((req,res)=>{
  handle(req,res).catch(err=>{
    if(res.headersSent){res.destroy();return;}
    const code=err.code===413?413:err.code===400?400:err.name==='TimeoutError'?504:502;
    const safe=/^(?:n8n_http_\d+|stt_http_\d+|elevenlabs_http_\d+|n8n_not_configured|stt_not_configured|voice_not_configured|file_too_large|bad_json|n8n_invalid_speak|stt_invalid_result)$/.test(err.message);
    fail(res,code,safe?err.message:'upstream_unavailable');
  });
}).on('error',e=>console.error('Server error:',e.message));
process.on('unhandledRejection',()=>console.error('Unexpected async rejection'));
server.listen(PORT,'0.0.0.0',()=>console.log(`JARVIS ready: http://localhost:${PORT} (demo=${demo})`));
