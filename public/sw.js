// Cache ONLY static front-end assets; never cache voice, session, auth or CRM API responses.
const CACHE='jarvis-voice-beta-0.6.2-welcome-safe';
const ASSETS=['./','./index.html','./style.css?v=0.6.2','./app.js?v=0.6.2','./voice.js?v=0.6.2','./manifest.webmanifest','./assets/orb-texture.webp','./assets/icon-192.png','./assets/icon-512.png','./assets/icon-180.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET')return;
 const url=new URL(e.request.url);
 if(url.origin!==self.location.origin||url.pathname.includes('/api/')||url.pathname.includes('/health'))return;
 if(url.pathname.endsWith('.html')||url.pathname.endsWith('/')){
   e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
 }else {
   e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
 }
});
