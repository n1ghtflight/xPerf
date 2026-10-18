"use strict";
/* XPerf service worker, registered only by the static site (tools/build_site.py fills VERSION and PRECACHE).
   App shell: precached per release (URLs carry ?v=, so a new release is a new cache).
   AIRAC packs (packs/<cycle>/…) and OpenAP aircraft files never change: cached on first use, for offline plans.
   packs/current.json and the page itself: network first, so a new cycle or release is picked up when online.
   Live data (winds, terrain, METAR/TAF, map tiles) always goes to the network. */
const VERSION="__VERSION__", SHELL="xperf-shell-"+VERSION, DATA="xperf-data";
const PRECACHE=__PRECACHE__;

self.addEventListener("install",e=>e.waitUntil(caches.open(SHELL).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys()
  .then(keys=>Promise.all(keys.filter(k=>k.startsWith("xperf-shell-")&&k!==SHELL).map(k=>caches.delete(k))))
  .then(()=>self.clients.claim())));

const keep=(cache,req,res)=>{ if(res.ok){ const copy=res.clone(); caches.open(cache).then(c=>c.put(req,copy)); } return res; };
const cacheFirst=(cache,req)=>caches.match(req).then(hit=>hit||fetch(req).then(res=>keep(cache,req,res)));
const networkFirst=(cache,req,opts)=>fetch(req).then(res=>keep(cache,req,res)).catch(()=>caches.match(req,opts));

self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    if(req.mode==="navigate") return e.respondWith(networkFirst(SHELL,req,{ignoreSearch:true}));
    if(url.pathname.endsWith("/packs/current.json")) return e.respondWith(networkFirst(DATA,req));
    if(url.pathname.includes("/packs/")) return e.respondWith(cacheFirst(DATA,req));
    return e.respondWith(cacheFirst(SHELL,req));
  }
  if(url.hostname==="raw.githubusercontent.com"&&url.pathname.includes("/openap/")) return e.respondWith(cacheFirst(DATA,req));
});
