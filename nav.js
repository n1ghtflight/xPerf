"use strict";
/* =====================================================================
   Radio-navigation route planning (VOR / NDB / DME), nav log, map,
   airport information (weather, runways, ILS, charts, minimums) and
   takeoff / landing performance.
   Loaded before the main script; uses its globals at call time.
   ===================================================================== */

/* ---------------------------------------------------------------- navaid database */
const NAV={list:[],grid:new Map(),loaded:false,error:null};
const VOR_TYPES=new Set(["VOR","VOR-DME","VORTAC"]), NDB_TYPES=new Set(["NDB","NDB-DME"]);
const gridKey=(lat,lon)=>`${Math.floor(lat/2)},${Math.floor(lon/2)}`;

async function loadNavaids(){
  if(NAV.loaded||!HAS_SERVER) return;
  try{
    const rows=await XD.navaids();
    NAV.list=rows.map(r=>({ident:r[0],name:r[1],type:r[2],khz:r[3],lat:r[4],lon:r[5],elev:r[6]||0,country:r[7],
      slaved:r[8],magvar:r[9],usage:r[10],power:r[11],dme:r[12],apt:r[13]}));
    for(const n of NAV.list){ const k=gridKey(n.lat,n.lon); if(!NAV.grid.has(k)) NAV.grid.set(k,[]); NAV.grid.get(k).push(n); }
    NAV.loaded=true;
  }catch(e){ NAV.error=e.message; console.warn("navaids unavailable",e); }
}
function navaidsNear(lat,lon,radiusNM,filter=()=>true){
  const out=[], span=Math.ceil(radiusNM/120)+1;
  for(let i=-span;i<=span;i++) for(let j=-span;j<=span;j++){
    const cell=NAV.grid.get(`${Math.floor(lat/2)+i},${Math.floor(lon/2)+j}`); if(!cell) continue;
    for(const n of cell){ if(!filter(n)) continue; const d=gcDist({lat,lon},n)/NM; if(d<=radiusNM) out.push({n,d}); } }
  return out.sort((a,b)=>a.d-b.d);
}
// local magnetic variation (east +) from the nearest navaids' current variation (WMM-derived values in OurAirports)
function magVarAt(lat,lon){
  if(!NAV.loaded) return 0;
  const near=navaidsNear(lat,lon,300,n=>n.magvar!=null).slice(0,6);
  if(!near.length) return 0;
  let w=0,s=0; for(const {n,d} of near){ const k=1/Math.max(d,1)**2; w+=k; s+=k*n.magvar; } return s/w;
}
const stationVar=n=>n.slaved!=null?n.slaved:(n.magvar!=null?n.magvar:magVarAt(n.lat,n.lon));
const norm360=a=>((a%360)+360)%360;
const fmtBrg=a=>String(Math.round(norm360(a))||360).padStart(3,"0");
const fmtFreq=n=>n.type.startsWith("NDB")?`${Math.round(n.khz)} kHz`:`${(n.khz/1000).toFixed(2)}`;

const MORSE={A:".-",B:"-...",C:"-.-.",D:"-..",E:".",F:"..-.",G:"--.",H:"....",I:"..",J:".---",K:"-.-",L:".-..",M:"--",N:"-.",O:"---",P:".--.",Q:"--.-",R:".-.",S:"...",T:"-",U:"..-",V:"...-",W:".--",X:"-..-",Y:"-.--",Z:"--..",
  0:"-----",1:".----",2:"..---",3:"...--",4:"....-",5:".....",6:"-....",7:"--...",8:"---..",9:"----."};
const morse=id=>String(id).toUpperCase().split("").filter(c=>MORSE[c]).map(c=>MORSE[c].replace(/\./g,"·").replace(/-/g,"–")).join("  ");

/* ---------------------------------------------------------------- reception range (AIM 1-1-8 / NDB classes) */
function stationClass(n){
  if(NDB_TYPES.has(n.type)) return n.power==="HIGH"?"HH":n.power==="MEDIUM"?"H":"MH";
  if(n.usage==="TERMINAL"||n.power==="LOW") return "T";
  return (n.usage==="HI"||n.power==="HIGH")?"H":"L";
}
function stationRange(n,altFt){
  const agl=Math.max(altFt-(n.elev||0),500), los=1.23*(Math.sqrt(agl)+Math.sqrt(30));
  const c=stationClass(n); let r;
  if(NDB_TYPES.has(n.type)) r={HH:75,H:50,MH:25}[c];
  else if(c==="T") r=25;
  else if(c==="L") r=agl<5000?40:70;
  else r=agl<5000?40:agl<14500?70:agl<18000?100:agl<=45000?130:100;
  return Math.min(r,los);
}

/* ---------------------------------------------------------------- route planner */
// Shortest station-to-station path where every leg stays within reception of a station
// (VOR-VOR legs need the two service volumes to overlap; airport legs need the station in range).
// If no fully covered path exists, the least-bad path is returned with the uncovered gaps flagged.
function planNavRoute(dep,arr,altFt,mode){
  const D=gcDist(dep,arr)/NM, slack=Math.max(60,0.35*D);
  const ok=n=>VOR_TYPES.has(n.type)||(mode==="vorndb"&&NDB_TYPES.has(n.type));
  let cands=[];
  const mid=gcInterp(dep,arr,0.5);
  for(const {n} of navaidsNear(mid.lat,mid.lon,D/2+slack,ok)){
    const e=gcDist(dep,n)/NM+gcDist(n,arr)/NM; if(e<=D+slack) cands.push({n,e}); }
  cands=cands.sort((a,b)=>a.e-b.e).slice(0,450).map(c=>c.n);
  const nodes=[{apt:dep,lat:dep.lat,lon:dep.lon,r:0},...cands.map(n=>({nav:n,lat:n.lat,lon:n.lon,r:stationRange(n,altFt)})),{apt:arr,lat:arr.lat,lon:arr.lon,r:0}];
  const N=nodes.length, last=N-1, dist=new Float64Array(N).fill(Infinity), prev=new Int32Array(N).fill(-1), done=new Uint8Array(N);
  const legCost=(a,b)=>{
    const d=gcDist(a,b)/NM;
    if(a.apt&&b.apt) return {d,cost:d*3+200,gap:d};                       // no station guidance at all
    const reach=a.apt?b.r:b.apt?a.r:a.r+b.r, gap=Math.max(0,d-reach);
    const ndb=(a.nav&&NDB_TYPES.has(a.nav.type))||(b.nav&&NDB_TYPES.has(b.nav.type));
    return {d,gap,cost:d*(ndb?1.12:1)+4+(gap>0?60+gap*4:0)};
  };
  dist[0]=0;
  for(let it=0;it<N;it++){
    let u=-1,best=Infinity; for(let i=0;i<N;i++) if(!done[i]&&dist[i]<best){best=dist[i];u=i;}
    if(u<0||u===last) break; done[u]=1;
    for(let v=1;v<N;v++){ if(done[v]||v===u) continue; const c=dist[u]+legCost(nodes[u],nodes[v]).cost; if(c<dist[v]){dist[v]=c;prev[v]=u;} }
  }
  const path=[]; for(let v=last;v>=0;v=prev[v]){ path.unshift(nodes[v]); if(v===0) break; }
  const legs=[]; for(let i=1;i<path.length;i++){ const L=legCost(path[i-1],path[i]); legs.push({gap:L.gap,d:L.d}); }
  return {points:path.map(p=>p.apt?{kind:"apt",apt:p.apt,lat:p.lat,lon:p.lon,label:p.apt.icao}:{kind:"nav",nav:p.nav,lat:p.lat,lon:p.lon,label:p.nav.ident,r:p.r}),
    gaps:legs.map((l,i)=>({i,gap:l.gap})).filter(g=>g.gap>0.5), altFt, mode};
}

/* ---------------------------------------------------------------- route geometry */
// Polyline route: legs between points, sub-segments (<=100 NM) for track/wind interpolation, position at any fraction.
function buildRoute(points,plan){
  const legs=[]; let total=0;
  for(let i=1;i<points.length;i++){ const a=points[i-1],b=points[i],d=gcDist(a,b); legs.push({a,b,d,s0:total}); total+=d; }
  total=Math.max(total,1);
  const segs=[];
  for(const L of legs){ const n=Math.max(1,Math.ceil(L.d/NM/100));
    for(let k=0;k<n;k++){ const p=gcInterp(L.a,L.b,k/n), q=gcInterp(L.a,L.b,(k+1)/n);
      segs.push({f1:(L.s0+L.d*(k+1)/n)/total,trk:course(p,q)}); } }
  const pointAt=f=>{ const x=Math.min(Math.max(f,0),1)*total;
    const L=legs.find(l=>x<=l.s0+l.d+1e-6)||legs[legs.length-1]; return gcInterp(L.a,L.b,L.d?(x-L.s0)/L.d:0); };
  return {points,legs,total,segs,pointAt,trk:course(points[0],points[points.length-1]),plan:plan||null,
    nav:!!plan};
}

/* ---------------------------------------------------------------- profile lookup (altitude / time / fuel at a distance) */
function profileAtX(r,total,x){
  const interp=(pts,y)=>{ for(let i=1;i<pts.length;i++) if(pts[i].d>=y){ const a=pts[i-1],b=pts[i],f=(y-a.d)/Math.max(b.d-a.d,1e-6);
      return {h:a.h+(b.h-a.h)*f,t:a.t+(b.t-a.t)*f,fuel:a.fuel+(b.fuel-a.fuel)*f}; } return pts[pts.length-1]; };
  if(x<=r.climb.d) return interp(r.climb.pts,x);
  if(x>=total-r.descent.d){ const p=interp(r.descent.pts,total-x); return {h:p.h,t:r.time-p.t,fuel:r.trip-p.fuel}; }
  const f=r.cruise.dist?(x-r.climb.d)/r.cruise.dist:0;
  return {h:r.ft,t:r.climb.t+f*r.cruise.t,fuel:r.climb.fuel+f*r.cruise.fuel};
}

/* ---------------------------------------------------------------- fixes: express a position as radial/DME from the best VOR-DME */
function radialDme(pos,altFt){
  if(!NAV.loaded) return null;
  const near=navaidsNear(pos.lat,pos.lon,130,n=>VOR_TYPES.has(n.type)&&n.type!=="VOR").filter(o=>o.d<=stationRange(o.n,altFt));
  if(!near.length) return null;
  const {n,d}=near[0], radial=norm360(course(n,pos)-stationVar(n));
  return {n,text:`${n.ident} R-${fmtBrg(radial)} / ${d.toFixed(1)} DME`,freq:fmtFreq(n)};
}

/* ---------------------------------------------------------------- nav log */
// Leg data shared by the nav log and the FS2024 setup card: courses, heading, wind, time, fuel and radio settings.
function navLegs(X){
  const {route,sel,total,wxf,etd}=X, rows=[];
  const block=sel.block, tas=sel.cruise.tas, terr=X.terrain||[];
  const vors=route.points.map((P,k)=>({P,k})).filter(o=>o.P.kind==="nav"&&VOR_TYPES.has(o.P.nav.type));
  for(let i=0;i<route.legs.length;i++){
    const L=route.legs[i], A=route.points[i], B=route.points[i+1];
    const x0=L.s0, x1=L.s0+L.d, fm=(x0+x1)/2/total, midPt=gcInterp(A,B,0.5);
    const p0=profileAtX(sel,total,x0), p1=profileAtX(sel,total,x1), pm=profileAtX(sel,total,(x0+x1)/2);
    const tcOut=course(A,B), tcIn=norm360(course(B,A)+180), tc=course(midPt,B);
    const v=magVarAt(midPt.lat,midPt.lon), mc=norm360(tc-v);
    const w=wxf(fm,pm.h), legTas=(x1-x0)>0?(L.d/Math.max(p1.t-p0.t,1))-w.tail:tas;    // TAS implied by the profile on this leg
    const tasUse=Math.max(legTas,30*KT);
    const xr=w.xw||0, wca=deg(Math.asin(Math.max(-0.95,Math.min(0.95,-xr/tasUse))));
    const th=norm360(tc+wca), mh=norm360(th-v), gs=L.d/Math.max(p1.t-p0.t,1);
    // radio set-up for this leg: NAV1 = station flown TO (or FROM), ADF for NDB legs
    let nav1=null, adf=null;
    if(B.kind==="nav"&&VOR_TYPES.has(B.nav.type)) nav1={n:B.nav,obs:norm360(tcIn-stationVar(B.nav)),dir:"TO"};
    else if(A.kind==="nav"&&VOR_TYPES.has(A.nav.type)) nav1={n:A.nav,obs:norm360(tcOut-stationVar(A.nav)),dir:"FROM"};
    else { const back=vors.filter(o=>o.k<=i).pop(), fwd=vors.find(o=>o.k>i);
      if(back&&gcDist(back.P,midPt)/NM<=(back.P.r||stationRange(back.P.nav,pm.h))) nav1={n:back.P.nav,obs:norm360(course(back.P,B)-stationVar(back.P.nav)),dir:"FROM"};
      else if(fwd) nav1={n:fwd.P.nav,obs:norm360(course(A,fwd.P)-stationVar(fwd.P.nav)),dir:"TO"}; }
    if(B.kind==="nav"&&NDB_TYPES.has(B.nav.type)) adf={n:B.nav,brg:norm360(tcIn-v),dir:"TO"};
    else if(A.kind==="nav"&&NDB_TYPES.has(A.nav.type)) adf={n:A.nav,brg:norm360(tcOut-v),dir:"FROM"};
    // guidance text (full nav log)
    const g=[], meta=route.plan?.legs?.[i];
    if(meta&&meta.awy&&meta.awy!=="DCT"){
      g.push(`<b class="awy">${meta.awy}</b>${meta.crs!=null?` published <b>${fmtBrg(meta.crs)}°M</b>`:meta.proc?" — fly as published (see plate)":""}`);
      if(A.kind!=="nav"&&B.kind!=="nav"&&nav1) g.push(nav1.dir==="FROM"?`Outbound ${nav1.n.ident} R-${fmtBrg(nav1.obs)}`:`Inbound ${fmtBrg(nav1.obs)}° to ${nav1.n.ident}`);
      if(meta.cop) g.push(meta.cop);
    } else if(meta&&meta.awy==="DCT") g.push(`<span class="awy">DCT</span>${i===0?" (departure / vectors)":" (to the airport)"}`);
    if(A.kind==="nav"){ const n=A.nav;
      if(VOR_TYPES.has(n.type)) g.push(`Outbound <b>${n.ident} R-${fmtBrg(tcOut-stationVar(n))}</b>`);
      else g.push(`Outbound ${n.ident} QDR <b>${fmtBrg(tcOut-v)}°</b>`); }
    if(B.kind==="nav"){ const n=B.nav;
      if(VOR_TYPES.has(n.type)) g.push(`Inbound <b>${fmtBrg(tcIn-stationVar(n))}°</b> to ${n.ident} (R-${fmtBrg(tcIn-stationVar(n)+180)})`);
      else g.push(`Track QDM <b>${fmtBrg(tcIn-v)}°</b> to ${n.ident} (ADF)`); }
    let cop=null;
    if(!meta&&A.kind==="nav"&&B.kind==="nav"&&VOR_TYPES.has(A.nav.type)&&VOR_TYPES.has(B.nav.type)){
      const ra=A.r||stationRange(A.nav,pm.h), rb=B.r||stationRange(B.nav,pm.h); cop=L.d/NM*ra/(ra+rb);
      g.push(`COP ${cop.toFixed(0)} NM from ${A.nav.ident}`); }
    if(A.kind==="apt"&&B.kind==="apt") g.push("Pilotage / dead reckoning");
    const gap=route.plan&&route.plan.gaps.find(q=>q.i===i);
    if(gap) g.push(`<span style="color:var(--amber)">⚠ ${gap.gap.toFixed(0)} NM outside reception — DR</span>`);
    let tmax=0; for(const t of terr){ const xx=t.f*total; if(xx>=x0-1852&&xx<=x1+1852) tmax=Math.max(tmax,t.ft); }
    const msa=terr.length?Math.ceil((tmax+(tmax>3000?2000:1000))/100)*100:null;
    rows.push({i,A,B,x0,x1,guid:g.join("<br>"),tc,v,mc,wd:w.wd,ws:w.ws,wca,mh,dist:L.d/NM,gs:gs/KT,ete:p1.t-p0.t,eta:new Date(etd.getTime()+p1.t*1000),
      alt:p1.h,fuelRem:block-p1.fuel,msa,mea:meta?.mea,moca:meta?.moca,awy:meta?.awy,nav1,adf,cop,last:i===route.legs.length-1});
  }
  // mark the legs where top of climb / top of descent happen
  const xToc=sel.climb.d, xTod=total-sel.descent.d;
  for(const r of rows){ if(xToc>r.x0&&xToc<=r.x1) r.toc=true; if(xTod>=r.x0&&xTod<r.x1) r.tod=true; }
  return rows;
}
const nid=P=>P.kind==="apt"?`<b>${P.apt.icao}</b>`:P.kind==="fix"?`<b>${P.id}</b> <span class="note">${P.navType||"fix"}</span>`
  :`<b>${P.nav.ident}</b> <span class="note">${P.nav.type}</span>`;
const radioTxt=r=>[r.nav1?`<span class="freq">${fmtFreq(r.nav1.n)}</span> <span class="obs">OBS ${fmtBrg(r.nav1.obs)} ${r.nav1.dir}</span>`:"",
  r.adf?`<span class="adf">ADF</span> <span class="freq">${fmtFreq(r.adf.n)}</span> <span class="obs">${r.adf.dir==="TO"?"QDM":"QDR"} ${fmtBrg(r.adf.brg)}</span>`:""].filter(Boolean).join("<br>")||`<span class="note">${r.A.kind==="apt"&&r.B.kind==="apt"?"pilotage / GPS":"DR"}</span>`;
const fuelFmt=(X,kg)=>X.m.kind==="apm"?`${fmtK(kg/X.m.fuelDensity)} gal`:`${fmtK(kg)} kg`;
const altFmt=(r)=>r.last?"field":r.alt>=18000?lvl(r.alt):fmtK(Math.round(r.alt/100)*100);
function fixText(X,k){ const {route,sel,total}=X, x=k==="TOC"?sel.climb.d:total-sel.descent.d, f=radialDme(route.pointAt(x/total),sel.ft);
  return {x,f,html:`<b>${k}</b> ${nm(x).toFixed(1)} NM from ${X.dep.icao} (${nm(total-x).toFixed(1)} NM to go)${f?` — <b>${f.text}</b> <span class="note">(${f.freq})</span>`:""}`}; }

function navLog(X){
  const {route}=X, rows=X.legs||navLegs(X), awyMode=route.plan?.mode==="awy";
  const p=route.plan, srcNote=p?.mode==="awy"?`Published ${p.high?"Jet":"Victor"} airways from FAA NASR (cycle effective ${p.cycle}): MEA / MOCA, magnetic courses and changeover points as published; radials computed from the airway's VORs. Cruise level is kept at or above the highest MEA on the route (${fmtK(p.maxMea)} ft)${p.high?"":" and at or below 17,500 ft (Victor airway MAA)"}.`
    :p?.mode==="import"?`Your route${p.imp?.sb?` from SimBrief (${p.cycle})`:""}: waypoints flown in the order given${p.maxMea?`; FAA airway legs keep their MEA (cruise at or above ${fmtK(p.maxMea)} ft)`:""}. Radio stations are tuned when within range at ${lvl(p.altFt)} (AIM 1-1-8 service volumes).`
    :p?`Stations in range at ${lvl(p.altFt)}: VOR service volumes per AIM 1-1-8 (T 25 NM, L 40/70 NM, H up to 130 NM) limited by line of sight; NDB 25/50/75 NM by class. Radials use each VOR's published (slaved) variation; magnetic courses use local variation.`:"Direct great-circle route (GPS / pilotage).";
  const mark=r=>(r.toc?` <span class="tag toc">TOC</span>`:"")+(r.tod?` <span class="tag tod">TOD</span>`:"");
  return `<div class="tblwrap"><table class="navlog full"><tr><th>To</th><th>NAV / ADF</th><th>Heading</th><th>Alt</th><th>NM</th><th>ETE</th><th>Fuel left</th>
      <th class="det">Guidance</th><th class="det">TC</th><th class="det">Var</th><th class="det">MC</th><th class="det">Wind</th><th class="det">WCA</th><th class="det">GS</th><th class="det">ETA Z</th><th class="det">${awyMode?"MEA / MOCA":"MSA"}</th></tr>
    ${rows.map(r=>`<tr><td style="text-align:left">${nid(r.B)}${r.awy&&r.awy!=="DCT"?` <span class="awy">${r.awy}</span>`:""}</td><td style="text-align:left">${radioTxt(r)}</td>
      <td><span class="hdg">${fmtBrg(r.mh)}°</span></td><td>${altFmt(r)}${mark(r)}</td><td>${r.dist.toFixed(1)}</td><td>${hhmm(r.ete)}</td><td>${fuelFmt(X,r.fuelRem)}</td>
      <td class="det" style="text-align:left;white-space:normal;min-width:190px">${r.guid}</td><td class="det">${fmtBrg(r.tc)}</td><td class="det">${Math.abs(r.v).toFixed(0)}°${r.v>=0?"E":"W"}</td>
      <td class="det">${fmtBrg(r.mc)}</td><td class="det">${fmtBrg(r.wd)}/${Math.round(r.ws)}</td><td class="det">${r.wca>=0?"+":""}${r.wca.toFixed(0)}°</td><td class="det">${Math.round(r.gs)}</td>
      <td class="det">${r.eta.toISOString().slice(11,16)}</td><td class="det">${awyMode&&r.mea?`<b>${fmtK(r.mea)}</b>${r.moca?` / ${fmtK(r.moca)}`:""}`:r.msa!=null?fmtK(r.msa):"—"}</td></tr>`).join("")}
    </table></div>
    <div class="fixes"><div>${fixText(X,"TOC").html}</div><div>${fixText(X,"TOD").html}</div></div>
    <p class="note">${srcNote} Fuel left assumes minimum block fuel (${fuelFmt(X,X.sel.block)}). Wind from the Open-Meteo forecast at each leg's altitude. Always cross-check with current charts, NOTAMs and station status.</p>`;
}
// remember whether the detailed nav log is open
document.addEventListener("toggle",e=>{ if(e.target?.id==="detlog") try{ localStorage.setItem("xperf.detlog",e.target.open?"1":"0"); }catch(_){} },true);

/* ---------------------------------------------------------------- map (Leaflet) */
let MAP=null;
function drawMap(X){
  const el=document.getElementById("map"); if(!el||typeof L==="undefined") return;
  if(MAP){ MAP.remove(); MAP=null; }
  // fractional zoom so the route fills the frame instead of snapping one level too far out
  MAP=L.map(el,{zoomControl:true,attributionControl:true,zoomSnap:0.25,zoomDelta:0.5});
  const osm=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:18,className:"tiles-dark",
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'});
  const topo=L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",{maxZoom:17,subdomains:"abc",
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'});
  let pref="osm"; try{ pref=localStorage.getItem("xperf.map")||"osm"; }catch(_){}
  (pref==="topo"?topo:osm).addTo(MAP);
  L.control.layers({"Map (dark)":osm,"Terrain (OpenTopoMap)":topo},null,{position:"topright"}).addTo(MAP);
  MAP.on("baselayerchange",e=>{ try{ localStorage.setItem("xperf.map",e.layer===topo?"topo":"osm"); }catch(_){} });
  const {route,total,sel}=X, line=[];
  for(const Lg of route.legs){ const n=Math.max(2,Math.ceil(Lg.d/NM/20)); for(let k=0;k<=n;k++){ const p=gcInterp(Lg.a,Lg.b,k/n); line.push([p.lat,p.lon]); } }
  L.polyline(line,{color:"var(--accent)",weight:3}).addTo(MAP);
  const legsMeta=route.plan?.legs;
  if(legsMeta) legsMeta.forEach((Lm,i)=>{ if(!Lm||Lm.awy==="DCT"||(i>0&&legsMeta[i-1]?.awy===Lm.awy)) return;
    const a=route.points[i], b=route.points[i+1], mpt=gcInterp(a,b,0.5);
    L.marker([mpt.lat,mpt.lon],{icon:L.divIcon({className:"awylbl",html:Lm.awy,iconSize:null}),interactive:false}).addTo(MAP); });
  const first=route.points[0], lastP=route.points[route.points.length-1];
  // airport labels sit on the outside of the route so they don't cover the first/last station
  const aptSide=A=>(A===first?first.lon<=lastP.lon:lastP.lon<first.lon)?"left":"right";
  // a navaid or fix on the airport (e.g. SFO VOR on KSFO) takes the other side, so both labels stay readable
  const side=P=>{ const A=[first,lastP].find(A=>A!==P&&gcDist(A,P)/NM<2); return A?(aptSide(A)==="left"?"right":"left"):"right"; };
  const off=d=>[d==="left"?-6:6,0];
  // a SID / STAR the route names that adds nothing to draw (vectors, or only a fix on the airport): say so at the airport
  const procs=route.plan?.imp?routeProcedures(route.plan.imp,X.dep,X.arr).filter(p=>!p.drawn):[];
  const procNote=end=>{ const p=procs.find(q=>q.end===end); if(!p) return "";
    return `<span class="maplbl-sub">${procedureLabel(p.name,end==="dep"?X.info?.dep?.procs?.sids:X.info?.arr?.procs?.stars)}</span>`; };
  for(const P of route.points){
    if(P.kind==="fix"){ const d=side(P); L.circleMarker([P.lat,P.lon],{radius:3,color:"var(--text-3)",fillColor:"var(--text-3)",fillOpacity:1,weight:1}).addTo(MAP).bindTooltip(P.id,{direction:d,offset:off(d),className:"maplbl"}); continue; }
    if(P.kind==="apt"){
      const d=aptSide(P);
      L.circleMarker([P.lat,P.lon],{radius:7,color:"var(--panel)",fillColor:"var(--good)",fillOpacity:1,weight:2}).addTo(MAP)
        .bindTooltip(P.apt.icao+procNote(P===first?"dep":"arr"),{permanent:true,direction:d,offset:off(d),className:"maplbl apt"})
        .bindPopup(`<b>${svgEsc(P.apt.icao)}</b> ${svgEsc(P.apt.name)}<br>Elev ${fmtK(P.apt.alt)} ft`);
    } else { const ndb=NDB_TYPES.has(P.nav.type);
      L.circle([P.lat,P.lon],{radius:(P.r||40)*NM,color:ndb?"var(--warn)":"var(--accent)",weight:1,opacity:.3,fill:false,dashArray:"4 6",interactive:false}).addTo(MAP);
      L.circleMarker([P.lat,P.lon],{radius:6,color:ndb?"var(--warn)":"var(--accent)",fillColor:"var(--panel)",fillOpacity:1,weight:3}).addTo(MAP)
        .bindTooltip(P.nav.ident,{permanent:true,direction:side(P),offset:off(side(P)),className:"maplbl"})
        .bindPopup(`<b>${svgEsc(P.nav.ident)}</b> ${svgEsc(P.nav.name)} ${svgEsc(P.nav.type)}<br>${fmtFreq(P.nav)} ${morse(P.nav.ident)}`); } }
  for(const [k,x,c] of [["TOC",sel.climb.d,"var(--good)"],["TOD",total-sel.descent.d,"var(--violet)"]]){
    const p=route.pointAt(x/total);
    L.circleMarker([p.lat,p.lon],{radius:5,color:"var(--panel)",fillColor:c,fillOpacity:1,weight:2}).addTo(MAP).bindTooltip(`${k} — ${nm(x).toFixed(1)} NM from ${X.dep.icao}`,{direction:"top",className:"maplbl"}); }
  MAP._routeBounds=L.latLngBounds(line);
  fitRouteMap(); requestAnimationFrame(fitRouteMap);
}
// the map fills the window below it (keeping the legend and the nav-log line in view), then shows the whole route
function fitRouteMap(){
  const el=document.getElementById("map"), host=document.getElementById("surface");
  if(!MAP||!el||!el.offsetParent||!host) return;
  const below=(el.parentElement.querySelector(".maplegend")?.offsetHeight||0)+(document.querySelector("#detlog summary")?.offsetHeight||0)+44;
  const top=el.getBoundingClientRect().top-host.getBoundingClientRect().top+host.scrollTop;
  const min=matchMedia("(max-width:767px)").matches?320:380;
  el.style.height=Math.round(Math.max(min,host.clientHeight-top-below))+"px";
  MAP.invalidateSize();
  if(MAP._routeBounds) MAP.fitBounds(MAP._routeBounds,{padding:[36,36]});
}
let fitMapT=0;
addEventListener("resize",()=>{ clearTimeout(fitMapT); fitMapT=setTimeout(()=>{ if(Shell.current()==="route") fitRouteMap(); },120); });

/* ---------------------------------------------------------------- airport information */
async function fetchAirportInfo(a){
  if(!HAS_SERVER||!a) return null;
  try{ return await XD.airportInfo(a); }catch(e){ return {error:e.message}; }
}
const SURF_PAVED=/ASP|CON|PEM|BIT|TAR|PAV|ASF|CONC|BRI|MAC/i, SURF_GRASS=/GRS|GRASS|TURF|GRE?N/i;
function surfaceKind(s){ return SURF_PAVED.test(s||"")?"paved":SURF_GRASS.test(s||"")?"grass":(s?"unpaved":"unknown"); }
function decodeMetar(mt){
  if(!mt) return null;
  const vis=mt.visib==null?null:typeof mt.visib==="string"?parseFloat(mt.visib):mt.visib;
  const ceil=(mt.clouds||[]).filter(c=>/BKN|OVC|OVX|VV/.test(c.cover)).map(c=>c.base).sort((a,b)=>a-b)[0]??null;
  const wdir=mt.wdir==="VRB"?null:+mt.wdir, wspd=+mt.wspd||0, wgst=+mt.wgst||0;
  const qnh=mt.altim||1013.25;
  return {raw:mt.rawOb,cat:mt.fltCat||"",wdir,vrb:mt.wdir==="VRB",wspd,wgst,vis,visTxt:mt.visib,ceil,temp:mt.temp,dewp:mt.dewp,qnh,inHg:qnh*0.02953,
    // runway wet if precipitation is reported at the field (vicinity "VC.." groups don't count)
    wet:String(mt.wxString||"").split(/\s+/).some(t=>t&&!/^VC/.test(t)&&/RA|DZ|SN|SG|PL|GR|GS|UP/.test(t)),wx:mt.wxString};
}
function windComp(hdgT,met){ // headwind (+) / crosswind for a runway heading (true; METAR wind is true in raw reports)
  if(!met||met.wdir==null) return {hw:0,xw:0,gxw:0,vrb:!!(met&&met.vrb&&met.wspd)};
  const a=rad(met.wdir-hdgT), s=met.wspd, g=Math.max(met.wgst,s);
  return {hw:s*Math.cos(a),xw:s*Math.sin(a),gxw:Math.abs(g*Math.sin(a)),side:Math.sin(a)>=0?"R":"L"};
}

/* ---------------------------------------------------------------- takeoff / landing performance */
// Base distances: XPerf table (POH distance over 50 ft / FAR 25 field length, MTOW, ISA, sea level) or OpenAP WRAP
// (observed ADS-B ground roll).
// Corrections follow the UK CAA Safety Sense 7 factors; safety factors 1.33 (T/O) and 1.43 (LDG) for GA,
// 1.15 / 1.67 (dry) for transport category.
function basePerf(m){
  if(m.kind==="apm"){ const P=m.P; return {to:P.takeOffDistance, ldg:P.landingDistance, v2:P.takeOffV2||(P.landingVat?P.landingVat*1.1:70), vat:P.landingVat||60,
    wTo:m.mtow, wLdg:m.mtow*0.95, sfTo:m.engineKind==="jet"?1.15:1.33, sfLdg:m.engineKind==="jet"?1.67:1.43, src:"XPerf table (published distance, MTOW, ISA, sea level)"}; }
  const W=m.wrap, ac=m.ac;
  return {to:W.to_d_tof.opt*1000, ldg:(W.ld_d_brk.opt*1000)+300, v2:W.to_v_lof.opt/KT, vat:W.ld_v_app.opt/KT,
    wTo:(ac.oew+ac.mtow)/2, wLdg:(ac.oew+ac.mlw)/2, sfTo:1.15, sfLdg:1.67, src:"OpenAP WRAP (observed ADS-B, typical weights) + 300 m air distance"};
}
function runwayPerf(m,end,other,rwy,met,elev,weight,phase){
  const b=basePerf(m); if(!b.to&&phase==="to"||!b.ldg&&phase==="ldg") return null;
  const qnh=met?.qnh||1013.25, oat=met?.temp??(15-2*elev/1000);
  const pa=elev+(1013.25-qnh)*27, isaDev=oat-(15-2*pa/1000), da=pa+118.8*isaDev;
  const sk=surfaceKind(rwy.surface), wet=!!met?.wet;
  const len=rwy.length*FT, slope=(other.elev!=null&&end.elev!=null&&rwy.length)?(other.elev-end.elev)/rwy.length*100:0;   // % uphill in direction of travel
  const wc=windComp(end.hdgT??0,met);
  let f, base, avail, sf;
  if(phase==="to"){
    const V=b.v2, hw=wc.hw; base=b.to; sf=b.sfTo; avail=len;
    f=Math.pow(weight/b.wTo,2)*(1+0.10*Math.max(pa,0)/1000)*(1+0.10*isaDev/10)
      *(sk==="grass"?(wet?1.3:1.2):sk==="unpaved"?1.25:1)*(slope>0?1+0.10*slope/2:1)
      *(hw>=0?Math.pow((V-0.5*hw)/V,2):Math.pow((V+1.5*-hw)/V,2));
  } else {
    const V=b.vat, hw=wc.hw; base=b.ldg; sf=b.sfLdg*(wet&&m.kind!=="apm"?1.15:1); avail=(rwy.length-(end.dthr||0))*FT;
    f=(weight/b.wLdg)*(1+0.05*Math.max(pa,0)/1000)*(1+0.05*isaDev/10)
      *(sk==="grass"?(wet?1.35:1.15):sk==="unpaved"?1.2:(wet?1.15:1))*(slope<0?1+0.10*(-slope)/2:1)
      *(hw>=0?Math.pow((V-0.5*hw)/V,2):Math.pow((V+1.5*-hw)/V,2));
  }
  const req=base*Math.max(f,0.4), fact=req*sf;
  return {req,fact,avail,margin:avail-fact,status:fact<=avail?"ok":req<=avail?"tight":"no",pa,da,slope,wet,sk};
}

/* ---------------------------------------------------------------- minimums */
function ilsMinimums(il,end,info){
  const tdze=end?.elev??il.gsElev??il.elev??null; if(tdze==null) return null;
  const precision=il.gs!=null && !/LOC|LDA|SDF/.test(il.type)||/ILS/.test(il.type);
  if(!precision) return {kind:"NPA",text:"LOC only — MDA per chart (typically 250–500 ft HAT)",da:null};
  return {kind:"CAT I",da:Math.round(tdze+200),dh:200,text:`Std CAT I: DA ${fmtK(Math.round(tdze+200))} ft (DH 200) · RVR 2400 ft / 550 m (½ SM)`};
}

/* ---------------------------------------------------------------- airport brief (shared by airport cards and the setup card) */
// runway ids differ between sources ("7L" in OurAirports, "07L" in FAA data and chart names)
const rwyKey=id=>String(id||"").toUpperCase().replace(/^0+(?=\d)/,"");
const CAT_COL={VFR:"var(--vfr)",MVFR:"var(--mvfr)",IFR:"var(--ifr)",LIFR:"var(--lifr)"};
// METAR flight category = current WEATHER at the field, not the flight rules being planned
const CAT_TIP="Weather category from the latest METAR (not your flight rules). VFR: ceiling above 3,000 ft and visibility over 5 SM · MVFR: ceiling 1,000–3,000 ft or visibility 3–5 SM · IFR: ceiling 500–999 ft or visibility 1–3 SM · LIFR: ceiling below 500 ft or visibility under 1 SM.";
function wxBadge(met,prefix=""){ return met?.cat?`<span class="cat" style="background:${CAT_COL[met.cat]||"var(--text-3)"}" title="${CAT_TIP}">${prefix}<span class="catlbl">wx</span> ${met.cat}</span>`:""; }
function flightRules(){ const r=$("rules").value; return r==="vfr"?"VFR":"IFR"; }
const FREQ_ORDER=["ATIS","AWOS","ASOS","CTAF","UNIC","GND","CLD","DEL","TWR","APP","A/D","DEP","CNTR","CTR"];
const fmtMHz=f=>f.mhz.toFixed(3).replace(/0$/,"");
function windTxt(met){ if(!met) return "—"; if(!met.wspd) return "calm"; if(met.vrb) return `VRB ${met.wspd} kt`;
  return `${fmtBrg(met.wdir)}° / ${met.wspd}${met.wgst?"G"+met.wgst:""} kt`; }
function rwyWindTxt(met,wc,xwLimit){
  if(!met) return "—"; if(!met.wspd) return "calm"; if(wc.vrb) return `VRB ${met.wspd}`;
  return `${wc.hw>=0?"H":"T"} ${Math.abs(Math.round(wc.hw))} / X ${Math.abs(Math.round(wc.xw))}${wc.side||""}${wc.gxw>xwLimit?' <span style="color:var(--red)">⚠</span>':""}`; }
function airportBrief(role,a,info,X,weight){
  if(!a) return null;
  if(!info||info.error) return {a,role,missing:true,error:info?.error};
  const var_=magVarAt(a.lat,a.lon), wx=info.wx||{}, met=decodeMetar(wx.metar), m=X.m;
  const xwLimit=m.kind==="apm"?(m.engineKind==="piston"?15:m.engineKind==="turboprop"?20:25):30;
  const phase=role==="Departure"?"to":"ldg";
  const ends=[];
  for(const r of info.runways||[]) for(let k=0;k<2;k++){ const e=r.ends[k], o=r.ends[1-k];
    let hdg=e.hdgT; if(hdg==null){ const n=parseInt(e.id); if(!isNaN(n)) hdg=norm360(n*10+var_); }
    const ee={...e,hdgT:hdg}, wc=windComp(hdg??0,met);
    ends.push({r,e:ee,o,wc,perf:runwayPerf(m,ee,o,r,met,e.elev??a.alt,weight,phase),ils:(info.ils?.list||[]).filter(i=>rwyKey(i.rwy)===rwyKey(e.id))}); }
  // best runway: most headwind (if any wind), then one that fits, then longest
  const fits=x=>!x.perf||x.perf.status!=="no";
  const best=ends.filter(x=>x.e.hdgT!=null).sort((p,q)=>(fits(q)-fits(p))||(met&&met.wspd?q.wc.hw-p.wc.hw:0)||(q.r.length-p.r.length))[0]||null;
  const fq=(info.freqs||[]).filter(f=>f.mhz&&f.mhz>=108);
  const pick=(...types)=>fq.find(f=>types.includes(f.type));
  const freqs={atis:pick("ATIS","AWOS","ASOS","AWIS"),ctaf:pick("CTAF","UNIC"),twr:pick("TWR"),gnd:pick("GND"),clr:pick("CLD","DEL"),app:pick("APP","A/D","DEP")};
  const ilsBest=best?.ils?.[0]||null;
  const approaches=(info.charts?.list||[]).filter(c=>c.code==="IAP");
  return {a,role,info,var_,wx,met,xwLimit,ends,best,ilsBest,freqs,fq,approaches,weight};
}
function ilsCourse(i,var_){ return i.courseM!=null?i.courseM:norm360((i.courseT??0)-var_); }
function tafHtml(t){ return t?t.replace(/\s+(?=(FM\d{6}|TEMPO|BECMG|PROB\d{2}))/g,"\n  "):""; }

/* ---------------------------------------------------------------- airport card */
function airportCard(B,X,{collapsed=false,eta=null,label="ETA"}={}){
  if(!B) return "";
  const {a,role}=B, head=`<h2>${role} — ${svgEsc(a.icao)} ${svgEsc(a.name)}</h2>`;
  if(!HAS_SERVER) return `<div class="card">${head}<p class="note">Start the app with <code>python server.py</code> to load runways, ILS, charts and live weather.</p></div>`;
  if(B.missing) return `<div class="card">${head}<p class="note">Airport data unavailable${B.error?": "+B.error:""}.</p></div>`;
  const {info,var_,wx,met,best,ilsBest,freqs,xwLimit,m=X.m}=B;
  // ---- summary strip: what you need at a glance
  const chip=(k,v,cls="")=>v?`<div class="sumchip ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`:"";
  const sum=`<div class="apsum">
    ${wxBadge(met)}
    ${chip("Runway",best?`${best.e.id} <span class="note">${best.e.hdgT!=null?fmtBrg(best.e.hdgT-var_)+"°":""}</span>`:"")}
    ${chip("Wind",met?windTxt(met)+(best&&met.wspd&&!best.wc.vrb?` <span class="note">${rwyWindTxt(met,best.wc,xwLimit)}</span>`:""):"")}
    ${chip("Altimeter",met?`${met.inHg.toFixed(2)} <span class="note">${Math.round(met.qnh)} hPa</span>`:"")}
    ${chip(freqs.atis?.type||"ATIS",freqs.atis?fmtMHz(freqs.atis):"","freq")}
    ${chip(freqs.twr?"TWR":"CTAF",freqs.twr?fmtMHz(freqs.twr):freqs.ctaf?fmtMHz(freqs.ctaf):"","freq")}
    ${chip("GND",freqs.gnd?fmtMHz(freqs.gnd):"","freq")}
    ${chip(ilsBest?`${ilsBest.type.split(/[ /]/)[0]} ${ilsBest.rwy}`:"",ilsBest?`${ilsBest.freq?.toFixed(2)} <span class="note">CRS ${fmtBrg(ilsCourse(ilsBest,var_))}°</span>`:"","freq")}
  </div>`;
  // ---- weather
  let wxHtml;
  if(met){
    const pa=a.alt+(1013.25-met.qnh)*27, da=pa+118.8*((met.temp??15)-(15-2*pa/1000));
    wxHtml=`<div class="wxrow"><span>Wind <b>${windTxt(met)}</b></span><span>Vis <b>${met.visTxt??"—"}${met.visTxt!=null?" SM":""}</b></span>
      <span>Ceiling <b>${met.ceil!=null?fmtK(met.ceil)+" ft":"none"}</b></span><span>Temp/Dew <b>${met.temp??"—"}/${met.dewp??"—"}°C</b></span>
      <span>Density alt <b>${fmtK(Math.round(da/10)*10)} ft</b></span></div>
      <div class="raw">${met.raw}</div>${wx.taf?`${tafTimeline(B,eta,label)}<details class="sub raw-taf"><summary>Raw TAF</summary><div class="raw taf">${tafHtml(wx.taf)}</div></details>`:""}
      ${wx.distNM?`<p class="note">No weather reporting at ${a.icao} — using <b>${wx.station}</b>, ${wx.distNM} NM away.</p>`:""}`;
  } else wxHtml=`<p class="note">${wx.error?"Live weather unavailable: "+svgEsc(wx.error):"No METAR within 60 NM"}.</p>`;
  // ---- runways
  const rwyRows=B.ends.map(x=>{ const {r,e,wc,perf:pp}=x, col=pp?{ok:"var(--green)",tight:"var(--amber)",no:"var(--red)"}[pp.status]:"inherit";
    return `<tr class="${x===best?"best":""}"><td><b>${e.id}</b>${x===best?" ★":""}</td><td>${e.hdgT!=null?fmtBrg(e.hdgT-var_)+"°":"—"}</td>
      <td>${fmtK(r.length)} × ${fmtK(r.width)}</td><td>${r.surface||"—"}${r.lighted?" · lit":""}</td>
      <td>${rwyWindTxt(met,wc,xwLimit)}</td>
      <td style="color:${col}">${pp?`${fmtK(Math.round(pp.fact/FT))} <span class="note">of</span> ${fmtK(Math.round(pp.avail/FT))}`:"—"}</td>
      <td>${x.ils.length?x.ils.map(i=>`${i.type.split(/[ /]/)[0]} ${i.freq?.toFixed(2)}`).join("<br>"):""}</td></tr>`; }).join("");
  const bp=basePerf(m), sf=role==="Departure"?bp.sfTo:bp.sfLdg;
  const rwyHtml=B.ends.length?`<div class="rwyviz">${runwayDiagram(B)}${distanceBars(B)}</div>
    <details class="sub"><summary>Runway table — heading, size, surface, wind, ILS</summary><div class="tblwrap"><table><tr><th>Rwy</th><th>Hdg °M</th><th>L × W ft</th><th>Surface</th><th>Wind H/X kt</th><th>${role==="Departure"?"Takeoff":"Landing"} distance ft</th><th>ILS</th></tr>${rwyRows}</table></div></details>
    <p class="note">★ recommended runway. Distance = required (× safety factor ${sf}) of ${role==="Departure"?"runway length":"landing distance available"}: <span style="color:var(--green)">fits</span> · <span style="color:var(--amber)">only unfactored fits</span> · <span style="color:var(--red)">too short</span>. ${bp.src}, corrected for ${fmtK(B.weight)} kg, density altitude, slope, surface${met?.wet?" (wet)":""} and wind. Crosswind ⚠ above ${xwLimit} kt.</p>`
    :`<p class="note">No runway data on record for ${a.icao} (OurAirports). Check the AIP / chart supplement.</p>`;
  // ---- ILS & minimums
  const ils=info.ils||{list:[]};
  const ilsRows=ils.list.map(i=>{ const e=B.ends.find(x=>rwyKey(x.e.id)===rwyKey(i.rwy)), mins=ilsMinimums(i,e?.e,info);
    return `<tr><td><b>${i.rwy}</b></td><td>${i.type}${i.cat?" · CAT "+i.cat:""}</td><td>${i.ident} <span class="morse">${morse(i.ident.replace(/^I-/,"I"))}</span></td><td><b>${i.freq?.toFixed(2)}</b></td>
      <td>${fmtBrg(ilsCourse(i,var_))}°</td><td>${i.gs!=null?i.gs.toFixed(1)+"°":"—"}</td><td>${i.dme||"—"}</td><td style="white-space:normal;text-align:left;min-width:240px">${mins?mins.text:"—"}${mins?.da!=null&&met?minsCheck(met,mins):""}</td></tr>`; }).join("");
  const ilsHtml=ils.list.length?`<div class="tblwrap"><table><tr><th>Rwy</th><th>Type</th><th>Ident</th><th>Freq</th><th>Course</th><th>GS</th><th>DME</th><th>Minimums</th></tr>${ilsRows}</table></div>
    <p class="note" style="color:${ils.current?"var(--muted)":"var(--amber)"}">Source: ${ils.source}. Standard CAT I baseline — the DA/MDA on the approach chart may be higher and always governs.</p>`
    :`<p class="note">No ILS or localizer on record.</p>`;
  // ---- frequencies (all), radio aids, charts
  const fq=B.fq.slice().sort((p,q)=>(FREQ_ORDER.indexOf(p.type)+99)%99-(FREQ_ORDER.indexOf(q.type)+99)%99);
  const fqHtml=fq.length?`<div class="chips">${fq.map(f=>`<span class="chip" data-copy="${fmtMHz(f)}">${f.type} <b>${fmtMHz(f)}</b>${f.desc&&f.desc!==f.type?` <span class="note">${svgEsc(f.desc)}</span>`:""}</span>`).join("")}</div>`:`<p class="note">No frequencies on record.</p>`;
  const near=NAV.loaded?navaidsNear(a.lat,a.lon,25,n=>VOR_TYPES.has(n.type)||NDB_TYPES.has(n.type)||n.type==="DME").slice(0,6):[];
  const nearHtml=`<div class="chips">${near.map(({n,d})=>`<span class="chip" data-copy="${fmtFreq(n)}"><b>${n.ident}</b> ${n.type} ${fmtFreq(n)} · ${d.toFixed(1)} NM ${fmtBrg(course(a,n)-var_)}° <span class="morse">${morse(n.ident)}</span></span>`).join("")}</div>`;
  let chHtml;
  if(info.charts){
    const Lc=info.charts.list, grp=c=>Lc.filter(x=>x.code===c);
    const iap=grp("IAP"), apd=grp("APD"), mins=grp("MIN"), other=Lc.filter(x=>!["IAP","APD","MIN"].includes(x.code));
    const kindOf=n=>/^ILS|^LOC|^LDA|^SDF/.test(n)?"precision":/VOR|NDB|TACAN/.test(n)?"radio":/RNAV|GPS|RNP/.test(n)?"gps":"other";
    const plate=c=>`href="${c.url}" target="_blank" data-plate="${c.url}" data-title="${svgEsc(c.name)}" data-apt="${a.icao}"`;
    chHtml=`<div class="chips">${[...apd,...mins].map(c=>`<a class="chip link" ${plate(c)}>📄 ${c.name}</a>`).join("")}</div>
      ${iap.length?`<div class="chips">${iap.map(c=>`<a class="chip link ${kindOf(c.name)}" ${plate(c)}>${c.name}</a>`).join("")}</div>`:`<p class="note">No instrument approaches published.</p>`}
      ${other.length?`<details><summary class="note">${other.length} departure / arrival procedures</summary><div class="chips">${other.map(c=>`<a class="chip link" ${plate(c)}>${c.code} ${c.name}</a>`).join("")}</div></details>`:""}
      <p class="note">Official FAA d-TPP, cycle ${info.charts.cycle} (effective ${info.charts.eff}). Click a chart to view it here (Ctrl+click opens a new tab). <span class="chipkey precision">ILS/LOC</span> <span class="chipkey radio">VOR/NDB</span> <span class="chipkey gps">RNAV</span></p>`;
  } else chHtml=`<p class="note">Free official charts are only available for the US. For ${a.icao}: <a href="https://chartfox.org/${a.icao}" target="_blank">ChartFox</a> · <a href="https://skyvector.com/airport/${a.icao}" target="_blank">SkyVector</a> · the national AIP.</p>`;
  const body=`<h3>Weather</h3>${wxHtml}
    <h3>Runways</h3>${rwyHtml}
    <h3>ILS / localizer</h3>${ilsHtml}
    <h3>Approach charts</h3>${chHtml}
    <details class="sub"><summary>All frequencies (${fq.length})</summary>${fqHtml}</details>
    ${near.length?`<details class="sub"><summary>Radio aids within 25 NM (${near.length})</summary>${nearHtml}</details>`:""}`;
  return `<div class="card apcard">${head}
    <div class="note" style="margin:-6px 0 10px">Elev ${fmtK(a.alt)} ft · Var ${Math.abs(var_).toFixed(1)}°${var_>=0?"E":"W"} · ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)}${a.iata?" · "+a.iata:""}</div>
    ${sum}
    ${collapsed?`<details class="sub"><summary>Weather, runways, ILS, charts and frequencies</summary>${body}</details>`:body}
  </div>`;
}
function minsCheck(met,mins,tdze){
  const ceilOk=met.ceil==null||met.ceil>=mins.dh, visOk=met.vis==null||met.vis>=0.5;
  return ` <span style="color:${ceilOk&&visOk?"var(--green)":"var(--red)"}">— current wx ${ceilOk&&visOk?"above":"BELOW"} CAT I</span>`;
}

/* =====================================================================
   US airways (FAA NASR): Victor below 18,000 ft, Jet FL180–FL450,
   Alaska colored LF/MF airways. Route along published segments with
   their MEA / MOCA / MAA, published magnetic course and changeover points.
   ===================================================================== */
const AWY={loaded:false,points:[],segs:[],adj:null,cycle:null,error:null};
const US_COUNTRIES=new Set(["US","PR","VI","GU","AS","MP"]);
const isUSApt=a=>US_COUNTRIES.has(a.country);

async function loadAirways(){
  if(AWY.loaded) return;
  const d=await XD.airways();
  AWY.points=d.points.map(p=>({id:p[0],lat:p[1],lon:p[2],kind:p[3],navType:p[4]}));
  AWY.segs=d.segs.map(s=>({awy:s[0],a:s[1],b:s[2],mea:s[3],moca:s[4],maa:s[5],crs:s[6],opp:s[7],cop:s[8],copDist:s[9]}));
  AWY.adj=AWY.points.map(()=>[]);
  AWY.segs.forEach((s,i)=>{ const d=gcDist(AWY.points[s.a],AWY.points[s.b])/NM; s.d=d;
    AWY.adj[s.a].push({to:s.b,seg:i,fwd:true}); AWY.adj[s.b].push({to:s.a,seg:i,fwd:false}); });
  AWY.cycle=d.cycle; AWY.loaded=true;
}

class MinHeap{ constructor(){this.a=[];} push(k,v){const a=this.a;a.push([k,v]);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p][0]<=a[i][0])break;[a[p],a[i]]=[a[i],a[p]];i=p;}}
  pop(){const a=this.a,top=a[0],last=a.pop();if(a.length){a[0]=last;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<a.length&&a[l][0]<a[m][0])m=l;if(r<a.length&&a[r][0]<a[m][0])m=r;if(m===i)break;[a[m],a[i]]=[a[i],a[m]];i=m;}}return top;}
  get size(){return this.a.length;} }

function planAirwayRoute(dep,arr,altFt,opts={}){
  const high=altFt>=18000, P=AWY.points, n=P.length, DEP=n, ARR=n+1;
  const segOk=s=>high?s.awy[0]==="J":(s.awy[0]==="V"||/^[ABGR]\d/.test(s.awy));
  const D=gcDist(dep,arr)/NM, slack=Math.max(80,0.4*D);
  const inCorr=new Uint8Array(n);
  for(let i=0;i<n;i++){ const e=(gcDist(dep,P[i])+gcDist(P[i],arr))/NM; if(e<=D+slack) inCorr[i]=1; }
  const onClass=new Uint8Array(n); AWY.segs.forEach(s=>{ if(segOk(s)){ onClass[s.a]=1; onClass[s.b]=1; } });
  // join/leave the airway system within R NM of the airports (radar vectors / direct to the first fix)
  // off-airway legs at each end stay short at low level so the route doesn't sneak around MEAs over terrain
  // an airport outside the US joins the airway system wherever it is cheapest; that end is planned VOR to VOR afterwards
  const R=high?150:30, RFAR=Math.max(400,D);
  const near=(a,far)=>{ const out=[]; for(let i=0;i<n;i++){ if(!onClass[i]||!inCorr[i]) continue; const d=gcDist(a,P[i])/NM; if(d<=(far?RFAR:R)) out.push({i,d}); }
    out.sort((x,y)=>x.d-y.d);
    // international end: join at the first US airways reached (the border area), not just before the destination
    if(far&&out.length){ const lim=out[0].d+(high?80:40); return out.filter(o=>o.d<=lim).slice(0,40); }
    return out.slice(0,25); };
  const entries=near(dep,opts.depFar), exits=new Map(near(arr,opts.arrFar).map(o=>[o.i,o.d]));
  const dist=new Float64Array(n+2).fill(Infinity), prev=new Int32Array(n+2).fill(-1), via=new Array(n+2).fill(null);
  const heap=new MinHeap(); dist[DEP]=0; heap.push(0,DEP);
  const relax=(u,v,c,how)=>{ if(dist[u]+c<dist[v]){ dist[v]=dist[u]+c; prev[v]=u; via[v]=how; heap.push(dist[v],v); } };
  while(heap.size){
    const [du,u]=heap.pop(); if(du>dist[u]) continue; if(u===ARR) break;
    if(u===DEP){ for(const e of entries) relax(DEP,e.i,e.d*1.15+6,{dct:true});
      relax(DEP,ARR,D*1.6+40,{dct:true}); continue; }
    if(exits.has(u)) relax(u,ARR,exits.get(u)*1.15+6,{dct:true});
    for(const e of AWY.adj[u]){ const s=AWY.segs[e.seg]; if(!segOk(s)||!inCorr[e.to]) continue;
      if(s.maa&&altFt>s.maa+1) continue;
      const pen=(s.mea&&s.mea>altFt)?1+Math.min((s.mea-altFt)/10000,0.5):1;  // mild preference for airways whose MEA fits the planned level
      const prevSeg=via[u]&&via[u].seg!=null?AWY.segs[via[u].seg]:null;
      relax(u,e.to,s.d*pen+0.2+(prevSeg&&prevSeg.awy!==s.awy?3:0),{seg:e.seg,fwd:e.fwd}); }
  }
  if(!isFinite(dist[ARR])) return null;
  const path=[]; for(let v=ARR;v!==-1;v=prev[v]) path.unshift(v);
  const points=[], legs=[]; let maxMea=0;
  for(let k=0;k<path.length;k++){
    const v=path[k];
    if(v===DEP){ points.push({kind:"apt",apt:dep,lat:dep.lat,lon:dep.lon,label:dep.icao}); continue; }
    if(v===ARR){ points.push({kind:"apt",apt:arr,lat:arr.lat,lon:arr.lon,label:arr.icao}); legs.push({awy:"DCT"}); continue; }
    const p=P[v], nav=p.kind==="nav"&&NAV.loaded?navaidsNear(p.lat,p.lon,3,x=>x.ident===p.id)[0]?.n:null;
    points.push(nav?{kind:"nav",nav,lat:p.lat,lon:p.lon,label:p.id,r:stationRange(nav,altFt)}:{kind:"fix",id:p.id,lat:p.lat,lon:p.lon,label:p.id,navType:p.navType});
    const h=via[v];
    if(h&&h.seg!=null){ const s=AWY.segs[h.seg]; maxMea=Math.max(maxMea,s.mea||0);
      legs.push({awy:s.awy,mea:s.mea,moca:s.moca,maa:s.maa,crs:h.fwd?s.crs:s.opp,
        cop:s.cop&&s.copDist?`COP ${Math.round(s.copDist)} NM ${h.fwd?"from "+P[s.a].id:"before "+P[s.a].id} → ${s.cop}`:null}); }
    else legs.push({awy:"DCT"});
  }
  // ICAO-style route string: KPAO OSI V25 SNS V113 ... KTRK
  const str=[points[0].label]; let cur=null;
  for(let i=0;i<legs.length;i++){ const L=legs[i], to=points[i+1].label;
    if(L.awy==="DCT"){ if(cur){ str.push(points[i].label); cur=null; } if(i<legs.length-1) str.push(to); }
    else if(L.awy!==cur){ if(cur) str.push(points[i].label); else if(str[str.length-1]!==points[i].label) str.push(points[i].label); str.push(L.awy); cur=L.awy; } }
  if(cur) str.push(points[points.length-2].label);
  str.push(points[points.length-1].label);
  return {points,legs,gaps:[],altFt,mode:"awy",high,maxMea,cycle:AWY.cycle,routeString:str.filter((x,i,a)=>x!==a[i-1]).join(" ")};
}

// ICAO-style route string from points + leg metadata (null / DCT legs list each waypoint, airway legs are compressed)
function routeStringOf(points,legs){
  const out=[points[0].label]; let cur=null;
  for(let i=0;i<legs.length;i++){ const L=legs[i], a=points[i].label, b=points[i+1].label, aw=L&&L.awy&&L.awy!=="DCT"?L.awy:null;
    if(aw){ if(aw!==cur){ if(cur) out.push(a); else if(out[out.length-1]!==a) out.push(a); out.push(aw); cur=aw; } }
    else { if(cur){ out.push(a); cur=null; } out.push(b); } }
  if(cur) out.push(points[points.length-1].label);
  return out.filter((x,i,a)=>x!==a[i-1]).join(" ");
}
// Airways with an international end: FAA airways inside the US, VOR to VOR from / to the foreign airport.
function planHybridRoute(dep,arr,altFt,mode="vor"){
  const depFar=!isUSApt(dep), arrFar=!isUSApt(arr);
  const plan=planAirwayRoute(dep,arr,altFt,{depFar,arrFar}); if(!plan) return null;
  const pts=plan.points.slice(), legs=plan.legs.slice(), gaps=[];
  const splice=(i)=>{ // replace leg i (pts[i] → pts[i+1]) by a VOR-to-VOR sub-route
    const A=pts[i], B=pts[i+1], a={...(A.apt||{}),lat:A.lat,lon:A.lon,icao:A.label}, b={...(B.apt||{}),lat:B.lat,lon:B.lon,icao:B.label};
    const sub=planNavRoute(a,b,altFt,mode); let mids=sub.points.slice(1,-1).filter(P=>gcDist(P,B)/NM>3&&gcDist(P,A)/NM>3);
    pts.splice(i+1,0,...mids); legs.splice(i,1,...Array(mids.length+1).fill(null));
    sub.gaps.forEach(g=>gaps.push({i:i+g.i,gap:g.gap})); return mids.length; };
  if(depFar&&pts.length>2) splice(0);                    // departure side first, so gap indices stay valid
  if(arrFar&&pts.length>2) splice(pts.length-2);
  return {...plan,points:pts,legs,gaps,hybrid:{depFar,arrFar},routeString:routeStringOf(pts,legs)};
}

// Victor routes: stay at or above each segment's MEA from top of climb until the approach area (last 15 NM).
// (Jet routes are exempt: FL180 is the floor of the jet structure and descents leave them via STARs / vectors.)
function meaClearance(r,route,total){
  const plan=route.plan; if(!plan||(plan.mode!=="awy"&&plan.mode!=="pub")||plan.high) return {ok:true};
  let worst=null;
  route.legs.forEach((L,i)=>{ const m=plan.legs[i]; if(!m||!m.mea) return;
    for(let k=0;k<=10;k++){ const x=L.s0+L.d*k/10; if(x<r.climb.d||x>total-15*NM) continue;
      const h=profileAtX(r,total,x).h; if(h<m.mea-50&&(!worst||m.mea-h>worst.deficit)) worst={deficit:m.mea-h,at:x,mea:m.mea,awy:m.awy}; } });
  return worst?{ok:false,...worst}:{ok:true};
}

/* =====================================================================
   FS2024 setup card: what to enter in the world map / EFB, how to set up
   the cockpit before takeoff, the leg-by-leg radio log and the arrival brief.
   ===================================================================== */
const LB=2.20462;
function msfsRouteType(X){
  const mode=X.navMode, p=X.route.plan;
  if(mode==="awy"||mode==="pub") return p?.high?"High-altitude airways":"Low-altitude airways";
  if(mode==="vor"||mode==="vorndb") return "VOR to VOR";
  if(mode==="import") return p?.legs?.some(l=>l&&l.awy&&l.awy!=="DCT"&&!l.proc)?(p.high?"High-altitude airways":"Low-altitude airways"):"Direct – GPS";
  return "Direct – GPS";
}
function sectionize(html){
  // turn every <div class="ssec">N · title</div> + its content into a collapsible <details>
  const end=html.lastIndexOf("</div>"), body=html.slice(0,end), tail=html.slice(end);
  const parts=body.split('<div class="ssec">'); let out=parts[0];
  for(let i=1;i<parts.length;i++){ const p=parts[i], j=p.indexOf("</div>"), title=p.slice(0,j), rest=p.slice(j+6);
    const key=(title.match(/^\s*(\d)/)||[])[1]||String(i);
    let open=true; try{ open=localStorage.getItem("xperf.sec."+key)!=="0"; }catch(_){}
    out+=`<details class="ssecd" data-sec="${key}" ${open?"open":""}><summary class="ssec">${title}</summary>${rest}</details>`; }
  return out+tail;
}
document.addEventListener("toggle",e=>{ const d=e.target; if(!d?.classList?.contains("ssecd")) return;
  try{ localStorage.setItem("xperf.sec."+d.dataset.sec,d.open?"1":"0"); }catch(_){} },true);
document.addEventListener("click",e=>{ const b=e.target.closest&&e.target.closest("[data-secall]"); if(!b) return;
  const open=b.dataset.secall==="open"; document.querySelectorAll("details.ssecd").forEach(d=>d.open=open); });
function setupCard(X){ return sectionize(setupCardHtml(X)); }
function setupCardHtml(X){
  const {m,sel,dep,arr,route}=X, D=X.briefs.dep, A=X.briefs.arr, legs=X.legs;
  const box=(k,v,s,{copy,cls=""}={})=>`<div class="sbox ${cls}"${copy?` data-copy="${copy}" title="Click to copy"`:""}><div class="k">${k}</div><div class="v">${v}</div>${s?`<div class="s">${s}</div>`:""}</div>`;
  const rwyOf=B=>B&&!B.missing&&B.best?B.best.e.id:null;
  const arrRwy=()=>aBest?aBest.e.id:null;
  const catBadge=B=>wxBadge(B?.met,`${B?.a?.icao} `);
  const apm=m.kind==="apm";
  // fuel to load: minimum block rounded up (whole gallons for GA, 100 kg for jets)
  const blockKg=sel.block, fuelGal=blockKg/m.fuelDensity;
  const fuelV=apm?`${Math.ceil(fuelGal)} gal`:`${fmtK(Math.ceil(blockKg/100)*100)} kg`;
  const fuelS=apm?`${fmtK(Math.ceil(fuelGal)*m.fuelDensity*LB)} lb ${m.fuelName} · trip ${Math.round(sel.trip/m.fuelDensity)} gal`
    :`${fmtK(Math.ceil(blockKg/100)*100*LB)} lb · ${fmtK(fuelGal)} US gal · trip ${fmtK(sel.trip)} kg`;
  const waypoints=route.plan?.routeString||route.points.slice(1,-1).map(P=>P.label).join(" ")||"direct";
  // cockpit
  const dm=D&&!D.missing?D.met:null, am=A&&!A.missing?A.met:null;
  // departure: chosen runway (default: best for the wind) and departure procedure
  const dEnd=D&&!D.missing?chosenDepRunway(D):null;
  const dp=D&&!D.missing?chosenProc(D,SID_KEY,["ODP","DP"],X,"sid",dEnd?.e.id):{list:[],sel:null};
  const star=A&&!A.missing?chosenProc(A,STAR_KEY,["STR"],X,"star"):{list:[],sel:null};
  const first=legs[0], nav1=first?.nav1, nextNav=legs.map(r=>r.nav1).find(n=>n&&nav1&&n.n!==nav1.n);
  const adf=legs.find(r=>r.adf)?.adf;
  const rwyHdg=dEnd?.e.hdgT!=null?fmtBrg(dEnd.e.hdgT-D.var_):null;
  const climbFpm=Math.max(300,Math.round(((sel.ft-dep.alt)*FT/sel.climb.t)/FPM/100)*100);
  const descFpm=Math.max(300,Math.round(((sel.ft-arr.alt)*FT/sel.descent.t)/FPM/100)*100);
  const rules=flightRules(), vfr=rules==="VFR";
  const xpdr=vfr?(dep.country==="US"?"1200":"7000"):"as assigned";
  const P=m.P||{}, W=m.wrap;
  const speeds=apm?`climb ${P.initialClimbIAS||"—"} · cruise ${Math.round(sel.cruise.tas/KT)} TAS · approach ${P.approachIAS||"—"} · Vat ${P.landingVat||"—"} kt`
    :`climb ${kt(W.cl_v_cas_const.opt)} kt / M${W.cl_v_mach_const.opt} · cruise M${m.cruiseMach.toFixed(2)} · approach ${kt(W.fa_va_avg.opt)} kt`;
  const fq=(B,k)=>B&&!B.missing&&B.freqs[k]?fmtMHz(B.freqs[k]):null;
  const atis=fq(D,"atis"), twr=fq(D,"twr")||fq(D,"ctaf"), gnd=fq(D,"gnd");
  // arrival
  const aAtis=fq(A,"atis"), aTwr=fq(A,"twr")||fq(A,"ctaf");
  // the chosen approach drives the arrival runway, NAV1, minimums and landing distance
  const ch=A&&!A.missing?chosenApproach(A):{opts:[],sel:null}, ap=ch.sel;
  const aBest=A&&!A.missing?(ap?.rwy?A.ends.find(x=>rwyKey(x.e.id)===ap.rwy)||A.best:A.best):null;
  const ils=ap?(ap.kind==="precision"?ap.ils:null):(A&&!A.missing?A.ilsBest:null);
  const aMins=ils?ilsMinimums(ils,aBest?.e,A.info):null;
  const fac=A&&!A.missing?approachFacility(A,ap):null;
  const diagram=A?.info?.charts?.list?.find(c=>c.code==="APD");
  const tod=fixText(X,"TOD"), toc=fixText(X,"TOC");
  const lp=aBest?.perf, lpCol=lp?{ok:"good",tight:"warn",no:"bad"}[lp.status]:"";
  const tp=dEnd?.perf||null, tpCol=tp?{ok:"good",tight:"warn",no:"bad"}[tp.status]:"";
  const legRows=legs.map(r=>`<tr><td style="text-align:left">${nid(r.B)}${r.awy&&r.awy!=="DCT"?` <span class="awy">${r.awy}</span>`:""}</td>
      <td style="text-align:left">${radioTxt(r)}</td><td><span class="hdg">${fmtBrg(r.mh)}°</span></td>
      <td>${altFmt(r)}${r.toc?' <span class="tag toc">TOC</span>':""}${r.tod?' <span class="tag tod">TOD</span>':""}</td><td>${r.dist.toFixed(0)}</td><td>${hhmm(r.ete)}</td><td>${fuelFmt(X,r.fuelRem)}</td></tr>`).join("");
  return `<div class="card setup">
    <div class="setuphead"><div><span class="title">${dep.icao}${dEnd?" "+dEnd.e.id:""} → ${arr.icao}${arrRwy()?" "+arrRwy():""}</span>
      <span class="rulesbadge ${vfr?"vfr":"ifr"}" title="Flight rules you are planning under (Level rules setting)">${rules}</span>
      <span class="note">${m.label} · ${msfsRouteType(X)} · ${lvl(sel.ft)} · ${hhmm(sel.time)}</span></div>
      <div class="cats">${catBadge(D)}${catBadge(A)}<span class="secbtns"><button data-secall="open" title="Expand all sections">Expand all</button><button data-secall="close" title="Collapse all sections">Collapse all</button></span></div></div>

    <div class="ssec">1 · Enter in the FS2024 world map / EFB</div>
    <div class="sgrid">
      ${box("Departure",`${dep.icao}${dEnd?` <small>RWY</small> ${dEnd.e.id}`:""}`,dp.sel?svgEsc(dp.sel.name)+(dp.via?" ("+dp.via+")":""):dEnd?(dEnd===D.best?(dm&&dm.wspd?"best for the wind":"longest runway"):"runway you chose"):"",{copy:dep.icao})}
      ${box("Arrival",`${arr.icao}${arrRwy()?` <small>RWY</small> ${arrRwy()}`:""}`,`${star.sel?svgEsc(star.sel.name)+(star.via?" ("+star.via+")":"")+" · ":""}${ap?svgEsc(ap.name):"visual approach"}`,{copy:arr.icao})}
      ${box("Flight rules",rules,vfr?"VFR cruising levels":"IFR levels · file IFR in the EFB")}
      ${box("Route type",msfsRouteType(X),waypoints,{copy:waypoints})}
      ${box("Cruise altitude",lvl(sel.ft),X.route.plan?.lim?.exactFt?"published TEC altitude":X.optBy==="time"?"fastest level":"lowest fuel level")}
      ${box("Fuel to load",fuelV,fuelS)}
      ${box(apm?"Takeoff weight":"Payload",apm?`${fmtK(sel.tow)} kg`:`${fmtK(X.load)} kg`,apm?`${fmtK(sel.tow*LB)} lb`:`${fmtK(X.load*LB)} lb · TOW ${fmtK(sel.tow)} kg`)}
      ${box("Departure time",X.etd.toISOString().slice(11,16)+"Z",X.etd.toISOString().slice(0,10)+" UTC")}
    </div>
    <div class="plnbar"><button class="sm" data-pln title="Microsoft Flight Simulator flight plan">⬇ Download .PLN for FS2024</button>
      <span class="note plnNote">Flight plan with route, airways, runways, SID/STAR and approach — load it from the FS2024 world map.</span></div>

    ${D&&!D.missing?departureBriefing(D,X,dEnd,dp):""}

    <div class="ssec">3 · Cockpit before takeoff</div>
    <div class="sgrid">
      ${box("Altimeter",dm?dm.inHg.toFixed(2):"—",dm?`inHg · ${Math.round(dm.qnh)} hPa`:"no METAR",{copy:dm?dm.inHg.toFixed(2):""})}
      ${box(`COM1 · ${atis?D.freqs.atis.type:twr?(fq(D,"twr")?"TWR":"CTAF"):"COM"}`,atis||twr||"—",atis&&twr?`then ${fq(D,"twr")?"TWR":"CTAF"} ${twr}`:"",{copy:atis||twr,cls:"radio"})}
      ${gnd?box("COM2 · GND",gnd,fq(D,"clr")?`clearance ${fq(D,"clr")}`:"",{copy:gnd,cls:"radio"}):""}
      ${box(`NAV1${nav1?" · "+nav1.n.ident:""}`,nav1?fmtFreq(nav1.n):"—",nav1?`OBS ${fmtBrg(nav1.obs)}° ${nav1.dir}`:(X.navMode==="direct"?"GPS direct":"no station"),{copy:nav1?fmtFreq(nav1.n):"",cls:"radio"})}
      ${nextNav?box(`NAV2 · ${nextNav.n.ident}`,fmtFreq(nextNav.n),`next: OBS ${fmtBrg(nextNav.obs)}° ${nextNav.dir}`,{copy:fmtFreq(nextNav.n),cls:"radio"}):""}
      ${adf?box(`ADF · ${adf.n.ident}`,fmtFreq(adf.n),`${adf.dir==="TO"?"QDM":"QDR"} ${fmtBrg(adf.brg)}°`,{copy:String(Math.round(adf.n.khz)),cls:"radio"}):""}
      ${box("Heading bug",rwyHdg?rwyHdg+"°":"—",first?`then ${fmtBrg(first.mh)}° on course`:"")}
      ${box("Autopilot ALT",sel.ft>=18000?lvl(sel.ft):fmtK(sel.ft),`VS +${fmtK(climbFpm)} fpm`)}
      ${box("Transponder",xpdr,vfr?"VFR":"IFR")}
      ${typeof takeoffSetupRow==="function"?takeoffSetupRow(X):""}
    </div>
    <div class="note" style="margin-top:6px">Speeds: ${speeds}. ${tp?`Takeoff distance <span class="${tpCol}">${fmtK(Math.round(tp.fact/FT))} ft</span> of ${fmtK(Math.round(tp.avail/FT))} ft available.`:""} Click any box to copy its value.</div>

    <div class="ssec">4 · Leg by leg <span class="note" style="font-weight:400">— TOC ${toc.f?toc.f.text:nm(toc.x).toFixed(1)+" NM from "+dep.icao}</span></div>
    <div class="tblwrap"><table class="legs"><tr><th>To</th><th>NAV / ADF</th><th>Heading</th><th>Alt</th><th>NM</th><th>ETE</th><th>Fuel left</th></tr>${legRows}</table></div>

    <div class="ssec">5 · Arrival briefing ${arr.icao}</div>
    ${star.list.length?`<div class="apprbar"><label>STAR / arrival</label>${procSelect(A,STAR_KEY,star,"Radar vectors / no STAR")}
      ${star.sel?`<button class="sm" data-plate="${star.sel.url}" data-title="${svgEsc(star.sel.name)}" data-apt="${A.a.icao}">View plate</button>`:""}
      ${star.via?`<span class="note">enter via <b>${star.via}</b></span>`:""}</div>`:""}
    ${ch.opts.length?`<div class="apprbar"><label for="apprSel">Approach</label>${approachSelect(A,ch)}
      ${ap?.url?`<button class="sm" data-plate="${ap.url}" data-title="${svgEsc(ap.name)}" data-apt="${A.a.icao}">View plate</button>`:""}
      ${diagram?`<button class="sm ghost" data-plate="${diagram.url}" data-title="Airport diagram" data-apt="${A.a.icao}">Airport diagram</button>`:""}
      ${A.info.charts?"":`<a href="https://chartfox.org/${A.a.icao}" target="_blank" rel="noopener">Plates on ChartFox ↗</a>`}</div>`:""}
    <div class="sgrid">
      ${box(A?.freqs?.atis?.type||"ATIS",aAtis||"—",aTwr?`${fq(A,"twr")?"TWR":"CTAF"} ${aTwr}`:(A?.wx?.distNM?`using ${A.wx.station} weather`:""),{copy:aAtis||aTwr,cls:"radio"})}
      ${box("Runway",aBest?aBest.e.id:"—",aBest?(am&&am.wspd?rwyWindTxt(am,aBest.wc,A.xwLimit)+" kt":"wind calm"):"no runway data")}
      ${ils?box(`${ils.type.split(/[ /]/)[0]} ${ils.rwy} · NAV1`,ils.freq?.toFixed(2),`CRS ${fmtBrg(ilsCourse(ils,A.var_))}°${ils.gs!=null?` · GS ${ils.gs.toFixed(1)}°`:""}`,{copy:ils.freq?.toFixed(2),cls:"radio"})
        :fac?box(`${NDB_TYPES.has(fac.type)?"ADF":"NAV1"} · ${fac.ident}`,fmtFreq(fac),`${svgEsc(ap.name)} · likely facility, confirm on the plate`,{copy:NDB_TYPES.has(fac.type)?String(Math.round(fac.khz)):fmtFreq(fac),cls:"radio"})
        :box("Approach",ap?.kind==="gps"?"RNAV":ap?.kind==="visual"?"Visual":ap?svgEsc(ap.name):"visual",ap?.kind==="gps"?"load it in the GPS / FMS":ap?.kind==="visual"?`pattern ~${fmtK(Math.round((A?.a?.alt||0)/100)*100+1000)} ft MSL`:"")}
      ${box("Minimums",aMins?.da!=null?`${fmtK(aMins.da)} ft`:ap?.kind==="visual"?"VFR":"see plate",aMins?.da!=null?`DA · std CAT I${am?" · "+(minsOk(am,aMins)?'<span class="good">wx above</span>':'<span class="bad">wx below</span>'):""}`:ap?.kind==="visual"?"ceiling 1,000 ft · vis 3 SM":ap?.url?"published DA / MDA on the plate":"")}
      ${box("Altimeter",am?am.inHg.toFixed(2):"—",am?`inHg · ${Math.round(am.qnh)} hPa`:"",{copy:am?am.inHg.toFixed(2):""})}
      ${box("Descent",`${nm(sel.descent.d).toFixed(0)} NM out`,`VS −${fmtK(descFpm)} fpm${tod.f?" · "+tod.f.text:""}`)}
      ${lp?box("Landing distance",`<span class="${lpCol}">${fmtK(Math.round(lp.fact/FT))} ft</span>`,`of ${fmtK(Math.round(lp.avail/FT))} ft available`):""}
    </div>
  </div>`;
}
function minsOk(met,mins){ return (met.ceil==null||met.ceil>=mins.dh)&&(met.vis==null||met.vis>=0.5); }
// click a value box / frequency chip to copy it (handy when typing into the sim's radios or EFB)
document.addEventListener("click",e=>{ const el=e.target.closest&&e.target.closest("[data-copy]"); if(!el||!el.dataset.copy) return;
  navigator.clipboard?.writeText(el.dataset.copy).then(()=>{ el.classList.add("copied"); setTimeout(()=>el.classList.remove("copied"),900); }).catch(()=>{}); });

/* =====================================================================
   Approaches & plates: pick the arrival approach (FAA d-TPP list in the US,
   ILS + visual approaches elsewhere); the arrival briefing follows it.
   Plates open in an in-app viewer.
   ===================================================================== */
const APPR_KEY="xperf.appr.";
function rwyFromName(n){ const m=String(n).match(/RWY\s*(\d{1,2}[LCR]?)/i); return m?rwyKey(m[1]):null; }
function apprKind(n){ return /^(ILS|LOC|LDA|SDF|GLS)/.test(n)?"precision":/VOR|NDB|TACAN/.test(n)?"radio":/RNAV|GPS|RNP/.test(n)?"gps":"other"; }
function approachOptions(B){
  if(!B||B.missing) return [];
  const opts=[], ilsList=B.info.ils?.list||[];
  const ilsFor=r=>ilsList.find(i=>rwyKey(i.rwy)===r)||null;
  if(B.approaches.length) for(const c of B.approaches){ const r=rwyFromName(c.name), k=apprKind(c.name);
    opts.push({id:"iap:"+c.name,name:c.name,rwy:r,kind:k,url:c.url,ils:k==="precision"&&r?ilsFor(r):null}); }
  else for(const i of ilsList){ const r=rwyKey(i.rwy); opts.push({id:"ils:"+r+":"+i.ident,name:`${i.type.split(/[ /]/)[0]} RWY ${i.rwy}`,rwy:r,kind:"precision",ils:i}); }
  for(const x of B.ends) opts.push({id:"vis:"+rwyKey(x.e.id),name:`Visual RWY ${x.e.id}`,rwy:rwyKey(x.e.id),kind:"visual"});
  return opts;
}
function chosenApproach(B){
  const opts=approachOptions(B); if(!opts.length) return {opts,sel:null};
  let id=null; try{ id=localStorage.getItem(APPR_KEY+B.a.icao); }catch(_){}
  const best=B.best?rwyKey(B.best.e.id):null;
  const hw=o=>{ const e=B.ends.find(x=>rwyKey(x.e.id)===o.rwy); return e&&B.met&&B.met.wspd&&!e.wc.vrb?e.wc.hw:0; };
  // IFR: prefer an ILS with at most a 5 kt tailwind (most headwind first); VFR: the best runway for the wind
  const ifr=$("rules").value!=="vfr";
  const ilsPick=ifr?opts.filter(o=>o.kind==="precision"&&o.ils&&hw(o)>=-5).sort((p,q)=>hw(q)-hw(p))[0]:null;
  const auto=ilsPick||opts.find(o=>o.rwy===best&&o.kind==="precision"&&o.ils)||opts.find(o=>o.rwy===best&&o.kind!=="visual")||opts.find(o=>o.rwy===best)||opts[0];
  return {opts,sel:opts.find(o=>o.id===id)||auto,auto};
}
function approachSelect(B,ch){
  const groups=[["precision","ILS / localizer"],["radio","VOR / NDB"],["gps","RNAV (GPS)"],["other","Other"],["visual","Visual"]];
  const wind=o=>{ const e=B.ends.find(x=>rwyKey(x.e.id)===o.rwy); return e&&B.met&&B.met.wspd&&!e.wc.vrb?` · ${e.wc.hw>=0?"head":"TAIL"} ${Math.abs(Math.round(e.wc.hw))} kt`:""; };
  return `<select id="apprSel" data-apt="${B.a.icao}" aria-label="Approach">${groups.map(([k,l])=>{ const os=ch.opts.filter(o=>o.kind===k); return os.length?`<optgroup label="${l}">${os.map(o=>
    `<option value="${svgEsc(o.id)}" ${o===ch.sel?"selected":""}>${svgEsc(o.name)}${o===ch.auto?" (suggested)":""}${wind(o)}</option>`).join("")}</optgroup>`:""; }).join("")}</select>`;
}
// radio facility a VOR / NDB approach most likely uses: the nearest one of that type within 20 NM
function approachFacility(B,ap){
  if(!ap||ap.kind!=="radio"||!NAV.loaded) return null;
  const want=/NDB/.test(ap.name)?NDB_TYPES:VOR_TYPES;
  return navaidsNear(B.a.lat,B.a.lon,20,n=>want.has(n.type))[0]?.n||null;
}

/* ---------------------------------------------------------------- plate viewer */
let PV=null;
function openPlate(url,title,icao){
  if(!PV){ PV=document.createElement("div"); PV.id="plateViewer"; PV.className="pv"; PV.hidden=true;
    PV.innerHTML=`<div class="pvbox" role="dialog" aria-modal="true" aria-label="Approach plate"><div class="pvbar"><select id="pvSel" aria-label="Chart"></select>
      <a id="pvTab" target="_blank" rel="noopener">Open in new tab ↗</a><button class="sm" id="pvClose" aria-label="Close">✕</button></div><iframe id="pvFrame" title="Approach plate"></iframe></div>`;
    document.body.appendChild(PV);
    PV.addEventListener("click",e=>{ if(e.target===PV) closePlate(); });
    PV.querySelector("#pvClose").addEventListener("click",closePlate);
    PV.querySelector("#pvSel").addEventListener("change",e=>showPlate(e.target.value)); }
  // every chart for this airport in the selector
  const info=window.LAST_X&&Object.values(LAST_X.info||{}).find(i=>i&&i.ident===icao);
  const list=info?.charts?.list||[{name:title,url,code:"IAP"}];
  const order={APD:0,IAP:1,MIN:2,DP:3,ODP:3,STAR:4,STR:4};
  PV.querySelector("#pvSel").innerHTML=list.slice().sort((a,b)=>(order[a.code]??5)-(order[b.code]??5)).map(c=>`<option value="${c.url}" ${c.url===url?"selected":""}>${icao} · ${svgEsc(c.name)}</option>`).join("");
  showPlate(url); PV.hidden=false; document.body.style.overflow="hidden";
}
function showPlate(url){ PV.querySelector("#pvFrame").src=url+"#view=FitV"; PV.querySelector("#pvTab").href=url; }
function closePlate(){ if(PV){ PV.hidden=true; PV.querySelector("#pvFrame").src="about:blank"; document.body.style.overflow=""; } }
document.addEventListener("click",e=>{ const el=e.target.closest&&e.target.closest("[data-plate]"); if(!el||e.ctrlKey||e.metaKey||e.shiftKey) return;
  e.preventDefault(); openPlate(el.dataset.plate,el.dataset.title||"",el.dataset.apt||""); });
document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&PV&&!PV.hidden) closePlate(); });
document.addEventListener("change",e=>{ if(e.target?.id==="apprSel"){ try{ localStorage.setItem(APPR_KEY+e.target.dataset.apt,e.target.value); }catch(_){}
  if(window.LAST_X){ const y=scrollY; render(LAST_X); scrollTo(0,y); } } });


/* =====================================================================
   Departure briefing: runway, departure procedure (SID / obstacle DP /
   radar vectors), takeoff minimums and the numbers for the takeoff roll.
   ===================================================================== */
const DEPRWY_KEY="xperf.deprwy.", SID_KEY="xperf.sid.", STAR_KEY="xperf.star.";
const savedPick=(key,icao)=>{ try{ return localStorage.getItem(key+icao); }catch(_){ return null; } };
// FAA procedures from the d-TPP index; continuation pages ("…, CONT.1") are attached to their procedure
function procList(B,codes){
  const out=[];
  for(const c of B?.info?.charts?.list||[]){ if(!codes.includes(c.code)) continue;
    const m=c.name.match(/^(.*?), CONT\.\d+$/);
    if(m){ const p=out.find(o=>o.name===m[1]); if(p) p.pages.push(c); continue; }
    out.push({name:c.name,code:c.code,url:c.url,rnav:/RNAV|RNP/.test(c.name),obstacle:c.code==="ODP",pages:[]}); }
  return out.sort((a,b)=>(a.obstacle===b.obstacle?0:a.obstacle?-1:1)||(a.rnav-b.rnav)||a.name.localeCompare(b.name));
}
const normProc=n=>String(n).toUpperCase().replace(/\((RNAV|OBSTACLE)[^)]*\)/g,"").replace(/[^A-Z0-9]/g,"");
// Suggest the procedure whose exit (SID) / entry (STAR) fix fits the planned route best.
// Score = detour via the fix + half its distance from the route; RNAV procedures only when flying GPS direct;
// runway-specific SIDs only for the chosen runway.
function suggestProc(B,list,X,kind,rwyId){
  const P=B?.info?.procs; if(!P||!list.length) return null;
  const meta=new Map([...(P.sids||[]),...(P.stars||[])].map(m=>[m.key,m]));
  const {dep,arr,route}=X, D=gcDist(dep,arr)/NM, gps=X.navMode==="direct";
  const samples=[...Array(41)].map((_,i)=>route.pointAt(i/40));
  const toRoute=E=>Math.min(...samples.map(q=>gcDist(E,q)/NM));
  let best=null;
  for(const p of list){
    if(p.obstacle) continue;
    const m=meta.get(normProc(p.name)); if(p.rnav&&!gps) continue;
    let score=60, via=null;                                       // vector / no-fix procedures: neutral score
    if(m&&m.ends.length){ score=Infinity;
      for(const E of m.ends){ const det=(gcDist(dep,E)+gcDist(E,arr))/NM-D, sc=det+0.5*toRoute(E); if(sc<score){ score=sc; via=E.fix; } } }
    if(kind==="sid"&&m&&m.runways.length&&rwyId&&!m.runways.map(rwyKey).includes(rwyKey(rwyId))) score+=500;
    if(!best||score<best.score) best={p,score,via};
  }
  return best&&best.score<Math.max(40,0.3*D)?best:null;
}
function chosenProc(B,key,codes,X,kind,rwyId){
  const list=procList(B,codes), v=savedPick(key,B.a.icao);
  let sug=X?suggestProc(B,list,X,kind,rwyId):null;
  // IFR only; STARs are suggested for turbine aircraft or flights in the flight levels; an obstacle DP when no SID fits
  const ifr=$("rules").value!=="vfr", m=X?.m;
  if(!ifr) sug=null;
  const pub=X?.route?.plan?.pub, tok=pub&&(kind==="sid"?pub.sid:pub.star);
  if(tok){ const P=B.info?.procs, ms=[...(P?.sids||[]),...(P?.stars||[])];
    const mm=ms.find(x=>(kind==="sid"?x.code.split(".")[0]:x.code.split(".")[1])===tok), pp=mm&&list.find(q=>normProc(q.name)===mm.key);
    if(pp){ const sel0=v==="__none"?null:(list.find(q=>q.name===v)||pp);
      return {list,sel:sel0,suggested:pp,via:sel0===pp?(kind==="sid"?pub.sid_trans:pub.star_trans):null}; } }
  if(kind==="star"&&sug&&!(m&&(m.kind==="openap"||m.engineKind!=="piston"||X.sel.ft>=18000))) sug=null;
  if(kind==="sid"&&!sug&&ifr){ const odp=list.find(p=>p.obstacle); if(odp) sug={p:odp,score:0,via:null}; }
  const sel=v==="__none"?null:(list.find(p=>p.name===v)||sug?.p||null);
  return {list,sel,suggested:sug?.p||null,via:sel&&sug&&sel===sug.p?sug.via:null};
}
function chosenDepRunway(D){ const id=savedPick(DEPRWY_KEY,D.a.icao); return D.ends.find(x=>x.e.id===id)||D.best; }
function procSelect(B,key,ch,noneLabel){
  const grp=(label,items)=>items.length?`<optgroup label="${label}">${items.map(p=>`<option value="${svgEsc(p.name)}" ${p===ch.sel?"selected":""}>${svgEsc(p.name)}${p===ch.suggested?" (suggested)":""}${p.pages.length?` (+${p.pages.length} page${p.pages.length>1?"s":""})`:""}</option>`).join("")}</optgroup>`:"";
  return `<select class="pick" data-key="${key}" data-apt="${B.a.icao}"><option value="__none" ${ch.sel?"":"selected"}>${noneLabel}${ch.suggested?"":" (suggested)"}</option>
    ${grp("Obstacle departure (ODP)",ch.list.filter(p=>p.obstacle))}${grp("Conventional (VOR / heading)",ch.list.filter(p=>!p.obstacle&&!p.rnav))}${grp("RNAV — needs GPS",ch.list.filter(p=>!p.obstacle&&p.rnav))}</select>`;
}
function runwaySelect(D,dEnd){
  const met=D.met;
  return `<select class="pick" data-key="${DEPRWY_KEY}" data-apt="${D.a.icao}" aria-label="Departure runway">${D.ends.map(x=>{
    const w=met&&met.wspd&&!x.wc.vrb?` · ${x.wc.hw>=0?"head":"TAIL"} ${Math.abs(Math.round(x.wc.hw))} / X ${Math.abs(Math.round(x.wc.xw))}`:"";
    const fit=x.perf?(x.perf.status==="no"?" · TOO SHORT":x.perf.status==="tight"?" · tight":""):"";
    return `<option value="${svgEsc(x.e.id)}" ${x===dEnd?"selected":""}>RWY ${x.e.id} · ${x.e.hdgT!=null?fmtBrg(x.e.hdgT-D.var_)+"°":""} · ${fmtK(x.r.length)} ft${w}${fit}${x===D.best?" (suggested)":""}</option>`; }).join("")}</select>`;
}
function departureBriefing(D,X,dEnd,dp){
  const box=(k,v,s,{copy,cls=""}={})=>`<div class="sbox ${cls}"${copy?` data-copy="${copy}" title="Click to copy"`:""}><div class="k">${k}</div><div class="v">${v}</div>${s?`<div class="s">${s}</div>`:""}</div>`;
  const met=D.met, lst=D.info.charts?.list||[], find=re=>lst.find(c=>re.test(c.name)&&c.code!=="IAP");
  const toMins=find(/^TAKEOFF MINIMUMS/), diagram=lst.find(c=>c.code==="APD"), hot=lst.find(c=>c.code==="HOT"), dva=find(/^DIVERSE VECTOR AREA/);
  const plateBtn=(c,label,cls="sm ghost")=>c?`<button class="${cls}" data-plate="${c.url}" data-title="${svgEsc(c.name)}" data-apt="${D.a.icao}">${label}</button>`:"";
  const p=dEnd?.perf, col=p?{ok:"good",tight:"warn",no:"bad"}[p.status]:"";
  const hdg=dEnd?.e.hdgT!=null?fmtBrg(dEnd.e.hdgT-D.var_):"—";
  const pa=met?D.a.alt+(1013.25-met.qnh)*27:D.a.alt, da=met?pa+118.8*((met.temp??15)-(15-2*pa/1000)):null;
  const first=X.legs?.[0], sel=dp.sel, vfr=$("rules").value==="vfr";
  const proc=sel?(sel.obstacle?"Fly the obstacle departure as published":sel.rnav?"RNAV SID — load it in the GPS / FMS":"Fly the SID as published (headings, altitudes, radials)")
    :vfr?`VFR departure — climb runway heading, then turn on course ${first?fmtBrg(first.mh)+"°":""}`:`Runway heading ${hdg}°, expect radar vectors to ${first?first.B.label:"the first fix"}`;
  const fq=k=>D.freqs[k]?fmtMHz(D.freqs[k]):null;
  return `<div class="ssec">2 · Departure briefing ${D.a.icao}</div>
    <div class="apprbar"><label>Runway</label>${runwaySelect(D,dEnd)}</div>
    ${D.info.charts?`<div class="apprbar"><label>SID / departure</label>${procSelect(D,SID_KEY,dp,vfr?"VFR departure / no procedure":"Radar vectors / no published procedure")}
      ${sel?plateBtn(sel,"View plate","sm"):""}${plateBtn(diagram,"Airport diagram",sel?"sm ghost":"sm")}${plateBtn(toMins,"Takeoff minimums")}${plateBtn(hot,"Hot spots")}${plateBtn(dva,"Diverse vector area")}
      ${dp.via?`<span class="note">exit via <b>${dp.via}</b></span>`:""}</div>`
      :`<div class="apprbar note">No free official departure charts outside the US — <a href="https://chartfox.org/${D.a.icao}" target="_blank" rel="noopener">charts on ChartFox ↗</a></div>`}
    <div class="sgrid">
      ${box("Runway",dEnd?dEnd.e.id:"—",dEnd?`${hdg}° · ${fmtK(dEnd.r.length)} × ${fmtK(dEnd.r.width)} ft · ${dEnd.r.surface||""}`:"no runway data")}
      ${box("Wind",met?windTxt(met):"—",dEnd&&met&&met.wspd&&!dEnd.wc.vrb?rwyWindTxt(met,dEnd.wc,D.xwLimit)+" kt":met?"":"no METAR")}
      ${box("Takeoff distance",p?`<span class="${col}">${fmtK(Math.round(p.fact/FT))} ft</span>`:"—",p?`of ${fmtK(Math.round(p.avail/FT))} ft · unfactored ${fmtK(Math.round(p.req/FT))}`:"")}
      ${box("Density altitude",da!=null?`${fmtK(Math.round(da/10)*10)} ft`:"—",met?`OAT ${met.temp}°C · field ${fmtK(D.a.alt)} ft`:"")}
      ${box("Clearance",fq("clr")||fq("gnd")||"—",fq("clr")?(fq("gnd")?`then GND ${fq("gnd")}`:""):fq("gnd")?"ground":"",{copy:fq("clr")||fq("gnd")||"",cls:"radio"})}
      ${box("Initial climb",sel?(sel.rnav?"RNAV SID":"per plate"):`${hdg}°`,proc+(dp.via?` · transition ${dp.via}`:""))}
    </div>
    ${p&&p.status!=="ok"?`<div class="note" style="margin-top:6px"><span class="${col}">Takeoff distance is ${p.status==="no"?"longer than the runway":"inside the safety margin only"} on RWY ${dEnd.e.id}.</span> Pick another runway, reduce weight, or wait for better wind/temperature.</div>`:""}`;
}
document.addEventListener("change",e=>{ const t=e.target; if(!t?.classList?.contains("pick")) return;
  try{ localStorage.setItem(t.dataset.key+t.dataset.apt,t.value); }catch(_){}
  if(window.LAST_X){ const y=scrollY; render(LAST_X); scrollTo(0,y); } });


/* =====================================================================
   Published routes: FAA preferred IFR routes, tower enroute (TEC) routes
   and coded departure routes for the city pair, expanded to waypoints by
   the server; the best match for the aircraft is suggested.
   ===================================================================== */
const PUB_KEY="xperf.pub.";
const PUB_TYPE={H:"Preferred IFR — high",L:"Preferred IFR — low",TEC:"Tower enroute (TEC)",NAR:"North American route",SHD:"Single direction — high",
  SLD:"Single direction — low",HPD:"High preferred",CDR:"Coded departure route"};
async function fetchPublishedRoutes(dep,arr){
  return XD.routes(dep,arr);
}
// aircraft class used by TEC altitude codes: J jet, M turboprop, P / Q non-jet
function tecClass(m){ return m.kind==="openap"||m.engineKind==="jet"?"J":m.engineKind==="turboprop"?"M":"P"; }
function routeAltitudes(r,m){
  const alt=(r.alt||"").toUpperCase(), cls=tecClass(m);
  const band=alt.match(/^(\d{2,3})\s*-\s*(\d{2,3})/);
  if(band) return {ok:true,min:+band[1]*100,max:+band[2]*100,txt:`FL${band[1]}–${band[2]}`};
  if(/^\d{4,5}$/.test(alt)) return {ok:true,max:+alt,txt:`${fmtK(+alt)} ft`};
  const groups=[...alt.matchAll(/([JMPQ]+)(\d{2,3})/g)];
  if(groups.length){ const g=groups.find(x=>x[1].includes(cls)||(cls==="P"&&x[1].includes("Q")));
    return g?{ok:true,max:+g[2]*100,txt:`${fmtK(+g[2]*100)} ft (${cls==="J"?"jets":cls==="M"?"turboprops":"props"})`}:{ok:false,txt:`not for ${cls==="J"?"jets":cls==="M"?"turboprops":"props"} (${alt})`}; }
  return {ok:true,txt:alt||""};
}
function scorePublished(r,m){
  const cls=tecClass(m), ac=(r.aircraft||"").toUpperCase(), alt=routeAltitudes(r,m);
  let ok=alt.ok, why="";
  if(/JET|TURBOJET/.test(ac)&&cls!=="J"){ ok=false; why="jets only"; }
  if(/PROP|SINGLE ENGINE|NON-?JET/.test(ac)&&cls==="J"){ ok=false; why="props only"; }
  if(!alt.ok) why=alt.txt;
  // high-altitude route: preferred high types, any J / Q airway, or a coded route flown by a jet / turboprop
  const high=/^(H|HPD|SHD|NAR)$/.test(r.type)||(r.points||[]).some(q=>q.via&&/^[JQ]\d/.test(q.via))||(r.type==="CDR"&&cls!=="P");
  if(high&&cls==="P"&&!(m.turbo||m.pressurized)){ ok=false; why=why||"high-altitude route"; }
  const pref={J:{H:0,CDR:10,HPD:5,SHD:5,NAR:15,L:30,SLD:30,TEC:20},M:{TEC:0,L:5,H:15,CDR:15},P:{TEC:0,L:5,SLD:5,H:40,CDR:40}}[cls];
  const score=(pref[r.type]??25)+(r.rnav?8:0)+(r.unresolved?.length?30:0)+(r.nm||0)/50;
  return {ok,why,score,alt,high};
}
function choosePublished(routes,m,dep,arr){
  const scored=routes.map((r,i)=>({r,i,...scorePublished(r,m)}));
  const usable=scored.filter(x=>x.ok), sug=(usable.length?usable:scored).slice().sort((a,b)=>a.score-b.score)[0];
  let saved=null; try{ saved=localStorage.getItem(PUB_KEY+dep.icao+"-"+arr.icao); }catch(_){}
  const sel=scored.find(x=>x.r.route===saved)||sug;
  return {scored,sel,sug};
}
function planFromPublished(dep,arr,pick,m){
  const r=pick.r, points=[aptPoint(dep)], legs=[];
  for(const q of r.points){
    const nav=q.kind==="nav"&&NAV.loaded?navaidsNear(q.lat,q.lon,3,x=>x.ident===q.id)[0]?.n:null;
    points.push(nav?{kind:"nav",nav,lat:q.lat,lon:q.lon,label:q.id,r:stationRange(nav,pick.alt.max||12000)}:{kind:"fix",id:q.id,lat:q.lat,lon:q.lon,label:q.id,navType:""});
    legs.push(q.via?(/^[VJQTABGRY]\d/.test(q.via)?{awy:q.via,mea:q.mea}:{awy:q.via,proc:true}):null);
  }
  points.push(aptPoint(arr)); legs.push({awy:"DCT"});
  const maxMea=Math.max(0,...legs.map(l=>l?.mea||0));
  return {points,legs,gaps:[],altFt:pick.alt.max||null,mode:"pub",high:pick.high,maxMea,pub:r,routeString:r.route,
    cycle:AWY.cycle||"current",lim:{minFt:pick.high?Math.max(maxMea,18000):maxMea,maxFt:pick.alt.max||(pick.high?45000:17500),
      exactFt:r.type==="TEC"&&pick.alt.max?pick.alt.max:null}};       // TEC routes are filed at their published altitude
}
/* ---------------------------------------------------------------- your own route: pasted text or a SimBrief OFP
   routeimport.js parses; this resolves idents against the navaid / airway data and builds the plan. */
let ROUTE_SB=null;          // last SimBrief OFP, used while the route box still shows its route
function routeIdIndex(){
  if(NAV.byId&&NAV.byIdKey===NAV.list.length+"/"+AWY.points.length) return NAV.byId;
  const m=new Map(), add=(k,v)=>{ if(!m.has(k)) m.set(k,[]); m.get(k).push(v); };
  for(const n of NAV.list) add(n.ident,{id:n.ident,lat:n.lat,lon:n.lon,kind:"nav",ref:n});
  for(const p of AWY.points) if(p.kind!=="nav") add(p.id,{id:p.id,lat:p.lat,lon:p.lon,kind:"fix",navType:p.navType});
  NAV.byId=m; NAV.byIdKey=NAV.list.length+"/"+AWY.points.length; return m;
}
// points along airway `name` after `entry` up to the first point called `exitId` (FAA airways only), or null
function airwayLeg(name,entry,exitId){
  if(!AWY.loaded||!AWY.adj) return null;
  const P=AWY.points;
  for(let s=0;s<P.length;s++){ if(P[s].id!==entry.id||gcDist(P[s],entry)/NM>5) continue;
    const prev=new Map([[s,null]]), q=[s];
    while(q.length){ const u=q.shift();
      if(u!==s&&P[u].id===exitId){ const out=[];
        for(let v=u;prev.get(v);v=prev.get(v).u){ const {e}=prev.get(v), p=P[v];
          out.unshift({id:p.id,lat:p.lat,lon:p.lon,kind:p.kind==="nav"?"nav":"fix",navType:p.navType,seg:AWY.segs[e.seg],fwd:e.fwd}); }
        return out; }
      for(const e of AWY.adj[u]){ if(AWY.segs[e.seg].awy!==name||prev.has(e.to)) continue; prev.set(e.to,{u,e}); q.push(e.to); } } }
  return null;
}
function importRoute(txt,dep,arr){
  const sb=ROUTE_SB&&ROUTE_SB.text===txt.trim()?ROUTE_SB:null;
  if(sb) return {from:DB.aptIndex[sb.dep]||null,to:DB.aptIndex[sb.arr]||null,points:sb.points,skipped:[],sb};
  const ix=routeIdIndex();
  return resolveRoute(txt,{dep,arr,findApt:id=>DB.aptIndex[id]||null,findFix:id=>ix.get(id)||[],airway:airwayLeg});
}
function planFromImport(dep,arr,imp,altFt){
  const points=[aptPoint(dep)], legs=[];
  for(const q of imp.points){
    if(q.kind==="apt"){ if(q.ref&&q.ref!==dep&&q.ref!==arr){ points.push(aptPoint(q.ref)); legs.push(null); } continue; }
    const nav=q.kind==="nav"&&NAV.loaded?(q.ref||navaidsNear(q.lat,q.lon,3,x=>x.ident===q.id)[0]?.n):null;
    points.push(nav?{kind:"nav",nav,lat:q.lat,lon:q.lon,label:q.id,r:stationRange(nav,altFt)}
      :{kind:"fix",id:q.id,lat:q.lat,lon:q.lon,label:q.id,navType:q.navType||"",region:q.region||null});
    const s=q.seg;
    legs.push(!q.via?null:s?{awy:q.via,mea:s.mea,moca:s.moca,maa:s.maa,crs:q.fwd?s.crs:s.opp}
      :q.sidstar||!/^[UKS]?[A-Z]\d{1,4}[A-Z]?$/.test(q.via)?{awy:q.via,proc:true}:{awy:q.via});
  }
  points.push(aptPoint(arr)); legs.push({awy:"DCT"});
  const maxMea=Math.max(0,...legs.map(l=>l?.mea||0)), high=legs.some(l=>l&&!l.proc&&/^[JQU]/.test(l.awy));
  return {points,legs,gaps:[],altFt,mode:"import",high,maxMea,imp,
    routeString:imp.sb?`${dep.icao} ${imp.sb.route} ${arr.icao}`.replace(/\s+/g," "):routeStringOf(points,legs),
    cycle:imp.sb?.airac?`AIRAC ${imp.sb.airac} (SimBrief)`:AWY.cycle||"current",lim:{minFt:maxMea}};
}
// one line for the planner's note: what was left out of the pasted route and why
function importNote(imp,dep,arr){
  const why={procedure:"SID / STAR — fly it from the chart",airway:"airway not in XPerf's data (FAA airways only) — flown direct",unknown:"not found"};
  const parts=[];
  if(imp.from&&imp.from!==dep||imp.to&&imp.to!==arr) parts.push(`The route is written for ${imp.from?.icao||dep.icao} → ${imp.to?.icao||arr.icao}; planned ${dep.icao} → ${arr.icao}.`);
  const groups={}; for(const s of imp.skipped) (groups[s.why]=groups[s.why]||[]).push(s.id);
  for(const k of Object.keys(groups)) parts.push(`Skipped ${groups[k].join(", ")} (${why[k]}).`);
  if(groups.unknown&&!(isUSApt(dep)&&isUSApt(arr))) parts.push("Outside the US XPerf knows navaids but not named fixes — load the SimBrief flight plan (it carries coordinates).");
  return parts.join(" ")||null;
}
function publishedPicker(X){
  const P=X.pub; if(!P) return "";
  const lbl=x=>`${PUB_TYPE[x.r.type]||x.r.type}${x.r.code?" "+x.r.code:""} · ${x.r.route} · ${x.alt.txt||"any altitude"} · ${fmtK(x.r.nm)} NM${x.r.rnav?" · GPS":""}${x.ok?"":" · ✗ "+(x.why||"not for this aircraft")}${x===P.sug?" (suggested)":""}`;
  return `<div class="apprbar"><label for="pubSel">Published route</label><select id="pubSel" data-key="${X.dep.icao}-${X.arr.icao}">${P.scored.slice().sort((a,b)=>(b.ok-a.ok)||(a.score-b.score)).map(x=>
    `<option value="${svgEsc(x.r.route)}" ${x===P.sel?"selected":""}>${svgEsc(lbl(x))}</option>`).join("")}</select>
    <span class="note">${P.scored.length} FAA route${P.scored.length>1?"s":""} for this city pair${P.sel.r.hours?` · hours ${P.sel.r.hours}`:""}${P.sel.r.dir?` · ${P.sel.r.dir}`:""}${P.sel.r.area?` · ${P.sel.r.area}`:""}</span></div>`;
}
document.addEventListener("change",e=>{ if(e.target?.id!=="pubSel") return;
  try{ localStorage.setItem(PUB_KEY+e.target.dataset.key,e.target.value); }catch(_){}
  if(document.body.classList.contains("planned")&&typeof Chips!=="undefined") Chips.replan(); else if(typeof calculate==="function") calculate(); });

/* ---------------------------------------------------------------- Airports view: list → detail */
// cards: the airportCard() HTML render() builds for each role (it owns the ETD/ETA arguments).
// All cards stay in the DOM (pickers, plates and briefings keep their hooks); only the selected one shows.
function airportsView(X,cards){
  const roles=[["dep","Departure",X.dep],["arr","Arrival",X.arr],["alt","Alternate",X.altApt]].filter(r=>r[2]&&cards[r[0]]);
  let sel=null; try{ sel=localStorage.getItem("xperf.aptSel"); }catch(_){}
  if(!roles.some(r=>r[0]===sel)) sel="dep";
  const row=([k,label,a])=>{
    const B=X.briefs?.[k], met=B&&!B.missing?B.met:null;
    const end=B&&!B.missing?(k==="dep"&&typeof chosenDepRunway==="function"?chosenDepRunway(B):B.best):null;
    const cat=met?.cat?`<span class="fcat ${met.cat.toLowerCase()}">${met.cat}</span>`:`<span class="fcat none">—</span>`;
    return `<button type="button" class="aptrow" data-apt="${k}" aria-selected="${k===sel}">${cat}
      <span class="aptname"><b>${svgEsc(a.icao)}</b> <span>${label} · ${svgEsc(a.name)}</span></span>
      <span class="aptmeta">${met?windTxt(met):"no METAR"}${end?` · RWY ${end.e.id}`:""}</span></button>`;
  };
  return `<div class="aptsplit">
    <div class="aptlist" role="listbox" aria-label="Airports">${roles.map(row).join("")}</div>
    <div class="aptdetail">${roles.map(([k])=>`<div data-detail="${k}"${k===sel?"":" hidden"}>
      <button type="button" class="aptback" data-aptback>‹ Airports</button>${cards[k]}</div>`).join("")}</div></div>`;
}
document.addEventListener("click",e=>{
  const r=e.target.closest&&e.target.closest(".aptrow[data-apt]");
  if(r){ const k=r.dataset.apt, root=r.closest(".aptsplit");
    root.querySelectorAll(".aptrow").forEach(b=>b.setAttribute("aria-selected",String(b===r)));
    root.querySelectorAll("[data-detail]").forEach(d=>d.hidden=d.dataset.detail!==k);
    root.classList.add("detail-open");
    try{ localStorage.setItem("xperf.aptSel",k); }catch(_){}
    return; }
  const back=e.target.closest&&e.target.closest("[data-aptback]");
  if(back) back.closest(".aptsplit").classList.remove("detail-open");
});
