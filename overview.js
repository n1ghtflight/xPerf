"use strict";
/* =====================================================================
   Overview: a bento of tiles summarising the plan. Every value here is read from the plan object X
   that calculate()/render() already computed; nothing is recalculated. Each tile opens its detail view.
   ===================================================================== */
function renderOverview(X){
  const {m,dep,arr,total,sel}=X, c=sel.climb, d=sel.descent, cr=sel.cruise, apm=m.kind==="apm";
  const esc=s=>String(s??"").replace(/[&<>"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const gal=kg=>kg/m.fuelDensity, fuelV=kg=>apm?fmtK(gal(kg)):fmtK(kg), fuelU=apm?"gal":"kg";
  const tile=(name,view,cls,inner,label)=>`<div class="tile ${cls}" data-tile="${name}" data-open="${view}" tabindex="0" role="button" aria-label="${esc(label)}">${inner}</div>`;
  const head=(icon,txt,right="")=>`<div class="tl"><svg class="i"><use href="#${icon}"/></svg>${txt}${right?`<span class="tr">${right}</span>`:""}</div>`;

  /* warnings: one compact callout; the full list is on the Profile view */
  const warn=planWarnings(X);
  const first=warn.length?String(warn[0]).split(/(?<=[.!?])\s/)[0]:"";
  const callout=warn.length?`<div class="callout warn" data-callout data-count="${warn.length}">
      <svg class="i"><use href="#i-alert"/></svg><div><b>${esc(first)}</b>${warn.length>1?`<span class="more"> +${warn.length-1} more</span>`:""}</div>
      <a href="#profile" data-open="profile">Show on profile →</a></div>`
    :`<div data-callout data-count="0" hidden></div>`;

  /* map: the route drawn to scale (equirectangular around the mid-latitude) */
  const pts=X.route.points, cosM=Math.cos(((dep.lat+arr.lat)/2)*Math.PI/180);
  const xs=pts.map(p=>p.lon*cosM), ys=pts.map(p=>-p.lat);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys), W=600, H=300, pad=36;
  const k=Math.min((W-2*pad)/Math.max(x1-x0,1e-6),(H-2*pad)/Math.max(y1-y0,1e-6));
  const P=i=>[(pad+(xs[i]-x0)*k+(W-2*pad-(x1-x0)*k)/2).toFixed(1),(pad+(ys[i]-y0)*k+(H-2*pad-(y1-y0)*k)/2).toFixed(1)];
  const line=pts.map((_,i)=>P(i).join(",")).join(" ");
  const nodes=pts.map((p,i)=>{ const [px,py]=P(i), end=i===0||i===pts.length-1;
    return `<circle cx="${px}" cy="${py}" r="${end?5:3}" class="${end?"ov-apt":"ov-wpt"}"/>${end?`<text x="${px}" y="${+py-10}" class="ov-lbl" text-anchor="middle">${esc(p.label)}</text>`:""}`; }).join("");
  const mapTile=tile("map","route","span-7 rows-2",head("i-route",`${X.route.nav?"Route":"Direct"} · ${Math.round(nm(total))} NM`,`${pts.length-2} waypoint${pts.length===3?"":"s"}`)+
    `<svg class="ovmap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polyline points="${line}" class="ov-route"/>${nodes}</svg>`,"Open route and nav log");

  /* cruise level with per-level comparison bars (allowed levels only) */
  const ok=X.results.filter(r=>!statusOf(r,X)[1]).sort((a,b)=>b.ft-a.ft);
  const near=ok.length>5?ok.slice(Math.max(0,Math.min(ok.findIndex(r=>r.ft===sel.ft)-2,ok.length-5)),Math.max(0,Math.min(ok.findIndex(r=>r.ft===sel.ft)-2,ok.length-5))+5):ok;
  const maxTrip=Math.max(...near.map(r=>r.trip),1);
  const bars=near.map(r=>`<div class="lvbar${r.ft===sel.ft?" on":""}"><span class="num">${lvl(r.ft)}</span><i style="--w:${(r.trip/maxTrip*100).toFixed(1)}%"></i><span class="num">${fuelV(r.trip)} ${fuelU}</span></div>`).join("");
  const cruiseTile=tile("cruise","fuel","span-5 rows-2",head("i-profile",$("fl").value==="auto"?"Optimum cruise":"Cruise level",esc($("rules").value.toUpperCase()))+
    `<div class="val num">${lvl(sel.ft)}</div><div class="sub">lowest fuel ${lvl(X.minFuel.ft)} · fastest ${lvl(X.minTime.ft)}</div><div class="lvbars">${bars}</div>`,"Open fuel and levels");

  /* time | distance */
  const etd=X.etd instanceof Date?X.etd:null, eta=etd?new Date(etd.getTime()+sel.time*1000):null;
  const tdTile=tile("time-distance","route","span-5 split",
    `<div>${head("i-clock","Flight time")}<div class="val num">${hhmm(sel.time)}</div><div class="sub">${eta?`ETA ${eta.toISOString().slice(11,16)}Z`:"air time"}</div></div>`+
    `<div>${head("i-route","Distance")}<div class="val num">${Math.round(nm(total))}<small>NM</small></div><div class="sub">${X.route.nav?`direct ${Math.round(nm(gcDist(dep,arr)))} NM`:`great circle · TC ${String(Math.round(X.route.trk)).padStart(3,"0")}°`}</div></div>`,"Open route");

  /* fuel: trip / reserve / extra (stacked) */
  const extra=Math.max(0,sel.block-sel.trip-sel.reserve), blk=Math.max(sel.block,1), seg=(cls,v)=>v>0?`<i class="${cls}" style="--w:${(v/blk*100).toFixed(2)}%"></i>`:"";
  const fuelTile=tile("fuel","fuel","span-4",head("i-fuel","Fuel",apm?esc(m.fuelName||""):"kg")+
    `<div class="val num">${fuelV(sel.block)}<small>${fuelU} block</small></div><div class="stack">${seg("trip",sel.trip)}${seg("res",sel.reserve)}${seg("ext",extra)}</div>`+
    `<div class="legend"><span><i class="trip"></i>Trip <b class="num">${fuelV(sel.trip)}</b></span><span><i class="res"></i>Reserve <b class="num">${fuelV(sel.reserve)}</b></span>${extra>0?`<span><i class="ext"></i>Extra <b class="num">${fuelV(extra)}</b></span>`:""}</div>`,"Open fuel and levels");

  /* cruise wind */
  const tail=Math.round(cr.tail/KT);
  const windTile=tile("wind","profile","span-3",head("i-wind","Cruise wind")+
    `<div class="windrow"><div class="val num ${tail>=0?"good":"warn"}">${tail>=0?"+":"−"}${Math.abs(tail)}<small>kt</small></div>`+
    `<svg class="windarrow ${tail>=0?"tail":"head"}" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/><path d="${tail>=0?"M10 20h18M22 13l7 7-7 7":"M30 20H12M18 13l-7 7 7 7"}"/></svg></div>`+
    `<div class="sub">${tail>=0?"tailwind":"headwind"} · ISA ${cr.dT>=0?"+":"−"}${Math.abs(Math.round(cr.dT))}°C</div>`,"Open profile");

  /* climb & descent sparkline with TOC/TOD and a terrain-conflict dot */
  const top=Math.max(sel.ft*1.15,(X.maxTerrain||0)*1.1,1000), SW=300, SH=90;
  const sx=v=>(v/total*SW).toFixed(1), sy=h=>(SH-4-(h/top)*(SH-10)).toFixed(1);
  const prof=[...c.pts.map(p=>[p.d,p.h]),...[...d.pts].reverse().map(p=>[total-p.d,p.h])].map(([a,b])=>`${sx(a)},${sy(b)}`).join(" ");
  const terr=X.terrain?`<polygon class="sp-terrain" points="0,${SH} ${X.terrain.map(t=>`${sx(t.f*total)},${sy(t.ft)}`).join(" ")} ${SW},${SH}"/>`:"";
  const tAt=(X.compromise||sel.belowTerrain)&&sel.terrain?.at!=null&&X.terrain?.length?X.terrain.reduce((q,t)=>Math.abs(t.f*total-sel.terrain.at)<Math.abs(q.f*total-sel.terrain.at)?t:q):null;
  const conflict=tAt?`<circle class="sp-conflict" cx="${sx(sel.terrain.at)}" cy="${sy(tAt.ft)}" r="4"/>`:"";
  const fpm=v=>Math.round(v/FPM), climbFpm=Math.round(fpm((sel.ft-dep.alt)*FT/c.t)/10)*10, descFpm=Math.round(fpm((sel.ft-arr.alt)*FT/d.t)/10)*10;
  const profTile=tile("profile","profile","span-5",head("i-profile","Climb & descent",`+${fmtK(climbFpm)} / −${fmtK(descFpm)} fpm`)+
    `<svg class="spark" viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="none" aria-hidden="true">${terr}<polyline class="sp-line" points="${prof}"/>`+
    `<circle class="sp-toc" cx="${sx(c.d)}" cy="${sy(sel.ft)}" r="3.5"/><circle class="sp-tod" cx="${sx(total-d.d)}" cy="${sy(sel.ft)}" r="3.5"/>${conflict}</svg>`+
    `<div class="sub splitsub"><span>TOC ${nm(c.d)<20?nm(c.d).toFixed(1):Math.round(nm(c.d))} NM · ${hhmm(c.t)}</span><span>TOD ${nm(d.d)<20?nm(d.d).toFixed(1):Math.round(nm(d.d))} NM out</span></div>`,"Open profile");

  /* departure / arrival weather and runway in use */
  const wxTile=(name,B,label,isDep)=>{
    const a=isDep?dep:arr;
    if(!B||B.missing) return tile(name,"airports","span-6",head("i-airports",`${label} · ${a.icao}`)+`<div class="sub">Weather and runway data unavailable${B?.error?": "+esc(B.error):""}.</div>`,"Open airports");
    const met=B.met, end=isDep&&typeof chosenDepRunway==="function"?chosenDepRunway(B):B.best;
    const cat=met?.cat?`<span class="fcat ${met.cat.toLowerCase()}">${met.cat}</span>`:`<span class="fcat none">no METAR</span>`;
    const rows=[["Wind",met?windTxt(met):"—"],["Vis",met?.visTxt!=null?`${esc(met.visTxt)} SM`:"—"],["Ceiling",met?.ceil!=null?`${fmtK(met.ceil)} ft`:"none"],
      ["Temp · QNH",met?`${met.temp??"—"}°C · ${Math.round(met.qnh)} hPa`:"—"]];
    const rw=end?`<div class="rwy"><b>RWY ${esc(end.e.id)}</b> <span>${rwyWindTxt(met,end.wc,B.xwLimit)}</span>${end.perf?`<span class="need ${end.perf.status}">needs ${fmtK(end.perf.fact/FT)} of ${fmtK(end.perf.avail/FT)} ft</span>`:""}</div>`:"";
    return tile(name,"airports","span-6",head("i-airports",`${label} · ${esc(a.icao)}`,cat)+
      `<div class="wxgrid">${rows.map(([k,v])=>`<div><span>${k}</span><b class="num">${v}</b></div>`).join("")}</div>${rw}`,`Open ${label.toLowerCase()} airport`);
  };

  return `${callout}<div class="bento">${mapTile}${cruiseTile}${tdTile}${fuelTile}${windTile}${profTile}`+
    `${wxTile("dep-wx",X.briefs?.dep,"Departure",true)}${wxTile("arr-wx",X.briefs?.arr,"Arrival",false)}</div>`;
}

// Tiles and the callout link open their detail view (click, Enter or Space).
document.addEventListener("click",e=>{ const t=e.target.closest&&e.target.closest("[data-open]"); if(!t) return; e.preventDefault(); Shell.showView(t.dataset.open); });
document.addEventListener("keydown",e=>{ if((e.key==="Enter"||e.key===" ")&&e.target.matches&&e.target.matches(".tile[data-open]")){ e.preventDefault(); Shell.showView(e.target.dataset.open); } });
