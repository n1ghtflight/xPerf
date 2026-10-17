"use strict";
/* =====================================================================
   Route import with no DOM, so it can be unit-tested (tests/routeimport.test.mjs).
   resolveRoute("KPAO OAK V195 ILA V200 RANGO KTRK", lookups) → {from, to, points:[{id,lat,lon,kind,via}], skipped:[{id,why}]}
     for a pasted route (SkyVector, SimBrief, ICAO item 15). Lookups are injected by nav.js: findApt(id),
     findFix(id) → candidates, airway(name, entryPoint, exitId) → points after the entry up to the exit.
   parseSimbriefXML(xml) → the OFP's airports, aircraft, times and navlog fixes (with coordinates, so it works
     worldwide even where XPerf has no fix or airway data).
   ===================================================================== */
var tokenizeRoute=function(text){
  return String(text||"").toUpperCase().split(/\s+/).map(t=>t.split("/")[0])
    .filter(t=>t&&t!=="DCT"&&t!=="IFR"&&t!=="VFR"&&!/^[NKM]\d{3,4}([AFSM]\d{3,4}|VFR)$/.test(t));   // speed / level groups
};

// 3720N12150W · 55N020W · ARINC 424 5020N (N lat W lon) / 50N20 (lon ≥ 100)
var parseCoord=function(t){
  const ok=(lat,lon)=>Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
  let m=/^(\d{2})(\d{2})?([NS])(\d{3})(\d{2})?([EW])$/.exec(t);
  if(m) return ok((+m[1]+(m[2]?+m[2]/60:0))*(m[3]==="S"?-1:1),(+m[4]+(m[5]?+m[5]/60:0))*(m[6]==="W"?-1:1));
  const Q={N:[1,-1],E:[1,1],S:[-1,1],W:[-1,-1]};
  m=/^(\d{2})(\d{2})([NESW])$/.exec(t); if(m) return ok(+m[1]*Q[m[3]][0],+m[2]*Q[m[3]][1]);
  m=/^(\d{2})([NESW])(\d{2})$/.exec(t); if(m) return ok(+m[1]*Q[m[2]][0],(100+ +m[3])*Q[m[2]][1]);
  return null;
};

var resolveRoute=function(text,{dep,arr,findApt,findFix,airway}){
  const AWY=/^[UKS]?[A-Z]\d{1,4}[A-Z]?$/, PROC=/^[A-Z]{2,6}\d[A-Z]?$/;
  const rad=x=>x*Math.PI/180;
  const dist=(a,b)=>{ const x=rad(b.lon-a.lon)*Math.cos(rad((a.lat+b.lat)/2)), y=rad(b.lat-a.lat); return Math.hypot(x,y); };
  const toks=tokenizeRoute(text);
  // an airport at either end (ICAO code, or a local ident that isn't also a fix) is the departure / arrival
  const endApt=t=>{ const a=findApt(t); return a&&(t.length===4||!findFix(t).length)?a:null; };
  let from=dep||null, to=arr||null;
  if(toks.length>=2){ const a=endApt(toks[0]); if(a){ from=a; toks.shift(); } }
  if(toks.length>=1&&(toks.length>=2||from!==dep)){ const a=endApt(toks[toks.length-1]); if(a){ to=a; toks.pop(); } }
  const points=[], skipped=[];
  const prev=()=>points[points.length-1]||(from?{id:from.icao,lat:from.lat,lon:from.lon}:null);
  const push=(p,via)=>{ const l=points[points.length-1]; if(l&&l.id===p.id&&dist(l,p)<0.0005) return; points.push({...p,via}); };
  const nearest=cands=>{ const ref=prev()||to; return ref?cands.slice().sort((a,b)=>dist(a,ref)-dist(b,ref))[0]:cands[0]; };
  for(let i=0;i<toks.length;i++){
    const t=toks[i], c=parseCoord(t);
    if(c){ push({id:t,lat:c.lat,lon:c.lon,kind:"coord"},null); continue; }
    if(AWY.test(t)&&i+1<toks.length&&points.length){
      const seg=airway(t,points[points.length-1],toks[i+1]);
      if(seg&&seg.length){ for(const p of seg) push(p,t); i++; continue; }
    }
    const cands=findFix(t);
    if(cands.length){ push(nearest(cands),null); continue; }
    if(AWY.test(t)){ skipped.push({id:t,why:"airway"}); continue; }   // not in the data: fly direct to its exit fix
    const a=findApt(t);
    if(a){ push({id:a.icao,lat:a.lat,lon:a.lon,kind:"apt",ref:a},null); continue; }
    skipped.push({id:t,why:PROC.test(t)?"procedure":"unknown"});
  }
  return {from,to,points,skipped};
};

var parseSimbriefXML=function(xml){
  const src=String(xml||"");
  const dec=s=>s.replace(/&(amp|lt|gt|quot|apos);/g,(_,e)=>({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}[e]));
  const block=(s,name)=>{ const m=new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s); return m?m[1]:""; };
  const tag=(s,name)=>dec(block(s,name).trim());
  if(!/<OFP[\s>]/.test(src)) throw new Error("Not a SimBrief flight plan (expected the OFP XML).");
  const status=tag(block(src,"fetch"),"status");
  if(status&&!/^success/i.test(status)) throw new Error(`SimBrief: ${status}`);
  const dep=tag(block(src,"origin"),"icao_code"), arr=tag(block(src,"destination"),"icao_code");
  if(!dep||!arr) throw new Error("SimBrief flight plan has no departure or destination airport.");
  const gen=block(src,"general"), ac=block(src,"aircraft");
  const points=[];
  for(const m of block(src,"navlog").matchAll(/<fix>([\s\S]*?)<\/fix>/g)){
    const f=m[1], id=tag(f,"ident"), type=tag(f,"type").toLowerCase(), lat=+tag(f,"pos_lat"), lon=+tag(f,"pos_long");
    if(!/^[A-Z0-9]{1,12}$/i.test(id)||!isFinite(lat)||!isFinite(lon)) continue;   // idents end up in the page and the .PLN
    if(type==="ltlg"&&/^TO[CD]$/.test(id)) continue;                         // top of climb / descent
    if(type==="apt"&&(id===dep||id===arr)) continue;
    if(points.length&&points[points.length-1].id===id) continue;
    const via=tag(f,"via_airway");
    points.push({id,lat,lon,kind:/^(vor|ndb)/.test(type)?"nav":type==="ltlg"?"coord":"fix",navType:type,
      via:via&&via!=="DCT"?via:null,sidstar:tag(f,"is_sid_star")==="1",region:tag(f,"icao_region")||null});
  }
  return {dep,arr,altn:tag(block(src,"alternate"),"icao_code")||null,depRwy:tag(block(src,"origin"),"plan_rwy")||null,
    arrRwy:tag(block(src,"destination"),"plan_rwy")||null,route:tag(gen,"route"),initialAlt:+tag(gen,"initial_altitude")||null,
    acType:tag(ac,"icaocode")||null,acName:tag(ac,"name")||null,airac:tag(block(src,"params"),"airac")||null,
    etdMs:+tag(block(src,"times"),"sched_out")*1000||null,points};
};
