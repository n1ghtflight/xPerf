/* =====================================================================
   XPerf data adapter — every data request of the app goes through XD.

   mode "server" (default with python server.py): the /api endpoints, exactly as before.
   mode "packs"  (?data=packs, localStorage xperf.data=packs, or the iOS app): prebuilt AIRAC packs made by
     build_packs.py (packs/current.json → packs/<cycle>/…json.gz) for all static data; live data is fetched at
     run time: winds aloft / terrain from Open-Meteo (CORS ok), METAR/TAF from aviationweather.gov through native
     HTTP in the iOS app or the local server's /api when one answers (the browser can't call AWC: no CORS).
   Uses fetchT()/get() from index.html at call time.
   ===================================================================== */
const XD=(()=>{
  const qs=new URLSearchParams(location.search);
  let pref=qs.get("data"); try{ pref=pref||localStorage.getItem("xperf.data"); }catch(_){}
  const native=!!window.Capacitor?.isNativePlatform?.();
  const http=location.protocol.startsWith("http");
  const mode=native||pref==="packs"?"packs":"server";
  const root=(qs.get("packs")||"packs/").replace(/\/?$/,"/");
  const AWC="https://aviationweather.gov";
  const NMR=3440.065, r=x=>x*Math.PI/180;
  const nmBetween=(a1,o1,a2,o2)=>{ const p1=r(a1),p2=r(a2),dl=p2-p1,dn=r(o2-o1);
    return 2*NMR*Math.asin(Math.min(1,Math.sqrt(Math.sin(dl/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dn/2)**2))); };
  const memo={};
  const once=(k,f)=>memo[k]||(memo[k]=f().catch(e=>{ delete memo[k]; throw e; }));

  /* ---------- live HTTP: native (iOS, no CORS) or browser fetch */
  async function httpText(url,ms=20000,anyStatus=false){     // anyStatus: return the body of an error reply too
    if(native&&window.Capacitor?.Plugins?.CapacitorHttp){
      const res=await Capacitor.Plugins.CapacitorHttp.get({url,headers:{"User-Agent":"XPerf (flight simulation planner)"},responseType:"text",connectTimeout:ms,readTimeout:ms});
      if(res.status>=400&&!anyStatus) throw new Error(`HTTP ${res.status}`);
      return typeof res.data==="string"?res.data:JSON.stringify(res.data); }
    const c=new AbortController(), t=setTimeout(()=>c.abort(),ms);
    try{ const res=await fetch(url,{signal:c.signal}); if(!res.ok&&!anyStatus) throw new Error(`HTTP ${res.status}`); return await res.text(); }
    finally{ clearTimeout(t); }
  }
  // local server.py answering /api (packs mode in a browser): lets live lookups the browser can't make go through it
  const proxy=()=>!http||native?Promise.resolve(false):
    (memo.proxy||(memo.proxy=fetchT("/api/health","json",4000).then(d=>!!d?.ok).catch(()=>false)));

  /* ---------- packs */
  async function gunzipJSON(url){
    const res=await fetch(url); if(!res.ok) throw new Error(`data pack file missing: ${url} (HTTP ${res.status})`);
    const buf=new Uint8Array(await res.arrayBuffer());
    // some hosts already decode .gz (Content-Encoding); otherwise inflate here
    const txt=buf[0]===0x1f&&buf[1]===0x8b?await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
      :new TextDecoder().decode(buf);
    return JSON.parse(txt);
  }
  const manifest=()=>once("manifest",async()=>{
    const cur=await fetchT(root+"current.json","json",15000);
    const m=await fetchT(root+cur.path+"manifest.json","json",15000);
    m.base=root+cur.path; m.shardSet=new Set(m.aptShards); m.originSet=new Set(m.routeOrigins); return m; });
  const pack=rel=>once("p:"+rel,async()=>gunzipJSON((await manifest()).base+rel+".gz"));
  const shardOf=id=>id.slice(0,2).toUpperCase().replace(/[^A-Z0-9]/g,"_").padEnd(2,"_");

  /* ---------- weather (port of navdata.weather) for when there is no server */
  const wxCache={};
  async function awc(path){
    const hit=wxCache[path]; if(hit&&Date.now()-hit.t<300000) return hit.d;
    const t=await httpText(AWC+path); const d=t.trim()?JSON.parse(t):[]; wxCache[path]={t:Date.now(),d}; return d; }
  async function weather(ident,lat,lon){
    const out={station:null,distNM:0,metar:null,taf:null};
    try{
      const q=id=>`/api/data/metar?ids=${id}&format=json&taf=true&hours=2`;
      let m=await awc(q(ident));
      if(!m.length&&lat!=null){
        const near=(await pack("stations.json")).map(s=>[nmBetween(lat,lon,s[1],s[2]),s[0]]).sort((a,b)=>a[0]-b[0]);
        for(const [d,id] of near.slice(0,6)){ if(d>60) break; m=await awc(q(id)); if(m.length){ out.distNM=Math.round(d*10)/10; break; } }
      }
      if(m.length){
        m=m.slice().sort((a,b)=>(a.obsTime||0)-(b.obsTime||0)).at(-1);
        out.station=m.icaoId;
        out.metar=Object.fromEntries(["rawOb","fltCat","wdir","wspd","wgst","visib","altim","temp","dewp","clouds","wxString","reportTime","lat","lon","elev","name"].map(k=>[k,m[k]??null]));
        out.taf=m.rawTaf||null;
        if(out.taf){ try{
          let t=await awc(`/api/data/taf?ids=${out.station}&format=json`);
          if(t.length){ t=t.slice().sort((a,b)=>String(a.issueTime||"").localeCompare(String(b.issueTime||""))).at(-1);
            out.tafValid=[t.validTimeFrom??null,t.validTimeTo??null];
            out.tafFcsts=(t.fcsts||[]).map(f=>Object.fromEntries(["timeFrom","timeTo","timeBec","fcstChange","probability","wdir","wspd","wgst","visib","vertVis","wxString","clouds"].map(k=>[k,f[k]??null]))); }
        }catch(e){ console.warn("decoded TAF unavailable",e); } }
      }
    }catch(e){ out.error=e.message; }
    return out;
  }

  /* ---------- airport info from a pack, in the /api/airportinfo shape */
  async function packAirportInfo(a){
    const m=await manifest(), US=a.country==="US";
    const rec=m.shardSet.has(shardOf(a.icao))?(await pack(`apt/${shardOf(a.icao)}.json`))[a.icao]||{}:{};
    const ilsSrc=US?m.ils.us:m.ils.other;
    const wxP=(async()=>{
      if(native) return weather(a.icao,a.lat,a.lon);
      if(await proxy()){ const q=new URLSearchParams({ident:a.icao,aliases:[a.iata,...(a.aliases||[])].filter(Boolean).join(","),country:a.country||"",lat:a.lat,lon:a.lon});
        try{ return (await fetchT("/api/airportinfo?"+q,"json",120000)).wx; }catch(e){ return {station:null,distNM:0,metar:null,taf:null,error:e.message}; } }
      return {station:null,distNM:0,metar:null,taf:null,error:"live METAR/TAF needs the app or the local server (aviationweather.gov blocks browser requests)"};
    })();
    return {ident:a.icao, runways:rec.r||[], freqs:rec.f||[],
      ils:rec.i?{...ilsSrc,list:rec.i}:US?{...m.ils.us,list:[]}:{source:m.xplane?"no ILS on record":m.ils.other.source,current:false,list:[]},
      charts:US?{cycle:m.charts.cycle,eff:m.charts.eff,list:(rec.c||[]).map(([code,name,pdf])=>({code,name,url:m.charts.base+pdf}))}:null,
      procs:US?rec.p||{sids:[],stars:[]}:null,
      wx:await wxP, pack:m.cycle};
  }

  /* ---------- ICAO regions (port of navdata.icao_regions) */
  let regGrid=null;
  async function packRegions(pts){
    const fx=await pack("fixregions.json");
    if(!regGrid){ regGrid=new Map();
      for(const l of Object.values(fx)) for(const f of l){ const k=Math.floor(f[0])+","+Math.floor(f[1]); if(!regGrid.has(k)) regGrid.set(k,[]); regGrid.get(k).push(f); } }
    return pts.map(p=>{
      const id=String(p.id||"").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6), lat=+p.lat, lon=+p.lon;
      const own=fx[id];
      if(own){ const f=own.reduce((b,f)=>nmBetween(lat,lon,f[0],f[1])<nmBetween(lat,lon,b[0],b[1])?f:b);
        if(nmBetween(lat,lon,f[0],f[1])<30) return f[2]; }
      let best=null;
      for(let di=-1;di<=1;di++) for(let dj=-1;dj<=1;dj++) for(const f of regGrid.get(`${Math.floor(lat)+di},${Math.floor(lon)+dj}`)||[]){
        const d=nmBetween(lat,lon,f[0],f[1]); if(d<60&&(!best||d<best[0])) best=[d,f[2]]; }
      return best?best[1]:null; });
  }

  /* ---------- terrain: Open-Meteo direct (CORS ok, retried), then the server's SRTM fallback when there is one */
  async function packTerrain(pts){
    const url="https://api.open-meteo.com/v1/elevation?latitude="+pts.map(p=>p.lat.toFixed(4)).join(",")+"&longitude="+pts.map(p=>p.lon.toFixed(4)).join(",");
    let last;
    for(const wait of [0,1500,3000]){ if(wait) await new Promise(f=>setTimeout(f,wait));
      try{ const j=await get(url,"json",15000); if(j.elevation) return {source:"Open-Meteo (Copernicus DEM)",elev:j.elevation}; }catch(e){ last=e; } }
    if(await proxy()) return serverTerrain(pts);
    throw last||new Error("terrain unavailable");
  }
  const serverTerrain=pts=>get("/api/terrain?locs="+pts.map(p=>`${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join("|"),"json",60000);

  const ids=a=>[a.icao,a.iata,...(a.aliases||[])].filter(Boolean).join(",");
  const S=mode==="server";
  return {
    mode, native,
    ok: http||native,                 // data available at all (file:// has neither server nor packs)
    label: async()=>S?"server":`offline packs AIRAC ${(await manifest()).cycle}`,
    airports: ()=>S?get("/api/airports","json",90000):pack("airports.json"),
    navaids:  ()=>S?get("/api/navaids","json",90000):pack("navaids.json"),
    airways:  ()=>S?get("/api/airways","json",180000):pack("airways.json"),
    airportInfo: a=>S?fetchT("/api/airportinfo?"+new URLSearchParams({ident:a.icao,aliases:[a.iata,...(a.aliases||[])].filter(Boolean).join(","),country:a.country||"",lat:a.lat,lon:a.lon}),"json",120000)
                     :packAirportInfo(a),
    routes: async(dep,arr)=>{
      if(S) return (await fetchT("/api/routes?"+new URLSearchParams({orig:ids(dep),dest:ids(arr),olat:dep.lat,olon:dep.lon,dlat:arr.lat,dlon:arr.lon}),"json",180000)).routes||[];
      const m=await manifest(); if(!m.originSet.has(dep.icao)) return [];
      const f=(await pack(`routes/${dep.icao.toUpperCase().replace(/[^A-Z0-9-]/g,"_")}.json`))[arr.icao]||[];
      return structuredClone(f);       // callers annotate route objects
    },
    regions: async pts=>S?(await fetchT("/api/regions?pts="+encodeURIComponent(pts.map(p=>`${p.id},${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|")),"json",60000)).regions
                        :packRegions(pts),
    terrain: pts=>S?serverTerrain(pts):packTerrain(pts),
    // SimBrief OFP XML (served with CORS): an OFP link, or a pilot ID / username → that pilot's latest OFP.
    // Error replies are XML with a <status> the caller shows, so their body is kept.
    simbrief: async src=>{ const s=String(src||"").trim(); let url;
      if(/^https?:\/\//i.test(s)){ const u=new URL(s); if(!/(^|\.)simbrief\.com$/i.test(u.hostname)) throw new Error("Only simbrief.com links can be fetched.");
        u.protocol="https:"; url=u.href; }
      else url="https://www.simbrief.com/api/xml.fetcher.php?"+new URLSearchParams(/^\d+$/.test(s)?{userid:s}:{username:s});
      return httpText(url,20000,true); },
    // EUROCONTROL APM, live (server scrape). Packs mode only through a local server; otherwise the caller uses apm_snapshot.json
    apm: async icao=>{ if(S||await proxy()) return get(`/api/apm/${icao}`,"json",30000); throw new Error("live EUROCONTROL lookup unavailable"); },
    weather,                          // exposed for tests / native use
  };
})();
