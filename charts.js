"use strict";
/* =====================================================================
   Charts (plain SVG, same style as the vertical profile):
     windLayer      – headwind / tailwind cross-section behind the profile
     levelChart     – trip fuel and time for each cruise level, with wind
     runwayDiagram  – runways to scale with the METAR wind arrow
     distanceBars   – takeoff / landing distance required vs available
     fuelChart      – fuel remaining along the route with reserve band
     tafTimeline    – flight category over the TAF period with ETD / ETA
   ===================================================================== */
// chart colours are theme tokens (resolved by the browser, so charts follow light/dark without re-rendering)
const CH={grid:"var(--line-soft)",axis:"var(--text-3)",text:"var(--text)",blue:"var(--accent)",green:"var(--good)",amber:"var(--warn)",red:"var(--bad)",magenta:"var(--violet)",dim:"var(--text-4)",halo:"var(--panel)"};
const svgEsc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ---------------------------------------------------------------- 1 · winds aloft cross-section */
// tail > 0 = tailwind (green), < 0 = headwind (red); opacity grows with strength (full at 50 kt)
function windColor(tailKt){ const t=Math.max(-1,Math.min(1,tailKt/50)), a=(0.10+0.55*Math.abs(t)).toFixed(2);
  return `color-mix(in oklch, var(${t>=0?"--good":"--bad"}) ${(a*100).toFixed(0)}%, transparent)`; }
function windLayer(X,x,y,top){
  if(!X.wx||!X.wxf) return "";
  const {total,wxf}=X, cols=48, rows=Math.min(24,Math.max(8,Math.round(top/1000)));
  let out=""; const dh=top/rows;
  for(let i=0;i<cols;i++){ const f0=i/cols, f1=(i+1)/cols, fm=(f0+f1)/2;
    for(let j=0;j<rows;j++){ const h0=j*dh, h1=(j+1)*dh, w=wxf(fm,(h0+h1)/2), tail=w.tail/KT;
      out+=`<rect x="${x(f0*total).toFixed(1)}" y="${y(h1).toFixed(1)}" width="${(x(f1*total)-x(f0*total)+0.6).toFixed(1)}" height="${(y(h0)-y(h1)+0.6).toFixed(1)}" fill="${windColor(tail)}"><title>${fmtK(Math.round((h0+h1)/2/100)*100)} ft, ${Math.round(nm(fm*total))} NM: ${tail>=0?"tailwind":"headwind"} ${Math.abs(Math.round(tail))} kt (wind ${fmtBrg(w.wd)}°/${Math.round(w.ws)} kt)</title></rect>`; } }
  // wind at the chosen cruise level, a few labels along the line
  // label the wind on the cruise segment at 1/4 and 3/4 (clear of the TOC/TOD and level labels)
  const c0=X.sel.climb.d, c1=total-X.sel.descent.d;
  const lab=(c1-c0>total*0.15?[0.25,0.75]:[]).map(q=>{ const d=c0+(c1-c0)*q, w=wxf(d/total,X.sel.ft), t=Math.round(w.tail/KT);
    return `<text x="${x(d)}" y="${y(X.sel.ft)-7}" font-size="10.5" text-anchor="middle" fill="${t>=0?CH.green:CH.red}" stroke="${CH.halo}" stroke-width="3" paint-order="stroke">${t>=0?"+":""}${t} kt</text>`; }).join("");
  return `<g class="windlayer">${out}${lab}</g>`;
}
function windLegend(){
  return `<div class="windlegend"><span>headwind</span><span class="wbar"></span><span>tailwind</span>
    <span class="note">kt along track · darker = stronger · hover the chart for exact values · Open-Meteo forecast</span></div>`;
}

/* ---------------------------------------------------------------- 2 · cruise level comparison chart */
function levelChart(X){
  const rs=X.results.slice().sort((a,b)=>a.ft-b.ft); if(rs.length<2) return "";
  const apm=X.m.kind==="apm", fu=kg=>apm?kg/X.m.fuelDensity:kg, unit=apm?"gal":"kg";
  const W=1000,H=280,pl=64,pr=64,pt=26,pb=84, iw=W-pl-pr, ih=H-pt-pb;
  const step=iw/rs.length, cx=i=>pl+step*(i+0.5);
  const fuels=rs.map(r=>fu(r.trip)), times=rs.map(r=>r.time/60);
  const pad=(lo,hi)=>{ const d=Math.max(hi-lo,hi*0.02,1); return [lo-d*0.15,hi+d*0.15]; };
  const [f0,f1]=pad(Math.min(...fuels),Math.max(...fuels)), [t0,t1]=pad(Math.min(...times),Math.max(...times));
  const yf=v=>pt+ih-(v-f0)/(f1-f0)*ih, yt=v=>pt+ih-(v-t0)/(t1-t0)*ih;
  const maxW=Math.max(10,...rs.map(r=>Math.abs(r.cruise.tail/KT)));
  let g="";
  // bands: selected level, excluded levels
  rs.forEach((r,i)=>{ const [st,bad]=statusOf(r,X);
    if(bad) g+=`<rect x="${cx(i)-step/2}" y="${pt}" width="${step}" height="${ih}" fill="url(#hatch)"><title>${lvl(r.ft)}: ${svgEsc(st)}</title></rect>`;
    if(r.ft===X.sel.ft) g+=`<rect x="${cx(i)-step/2+2}" y="${pt-18}" width="${step-4}" height="${ih+18}" rx="4" fill="color-mix(in srgb, var(--accent) 8%, transparent)" stroke="color-mix(in srgb, var(--accent) 40%, transparent)"/>
      <text x="${cx(i)}" y="${pt-6}" font-size="11" fill="${CH.blue}" text-anchor="middle">${r===X.best?"optimum":"selected"}</text>`; });
  const dec=f1-f0<8?1:0;
  // when every level is within a few minutes, show seconds so the time axis doesn't repeat
  const tfmt=sec=>t1-t0<5?`${Math.floor(sec/3600)}:${String(Math.floor(sec/60)%60).padStart(2,"0")}:${String(Math.round(sec%60)).padStart(2,"0")}`:hhmm(sec);      // small fuel ranges need a decimal so axis labels don't repeat
  for(let k=0;k<=4;k++){ const v=f0+(f1-f0)*k/4, yy=yf(v); g+=`<line x1="${pl}" x2="${W-pr}" y1="${yy}" y2="${yy}" stroke="${CH.grid}"/>
    <text x="${pl-8}" y="${yy+4}" font-size="11" fill="${CH.blue}" text-anchor="end">${v.toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec})}</text>
    <text x="${W-pr+8}" y="${yt(t0+(t1-t0)*k/4)+4}" font-size="11" fill="${CH.amber}">${tfmt((t0+(t1-t0)*k/4)*60)}</text>`; }
  const fl=rs.map((r,i)=>`${cx(i)},${yf(fuels[i])}`).join(" "), tl=rs.map((r,i)=>`${cx(i)},${yt(times[i])}`).join(" ");
  g+=`<polyline points="${tl}" fill="none" stroke="${CH.amber}" stroke-width="2" stroke-dasharray="5 4"/>`;
  g+=`<polyline points="${fl}" fill="none" stroke="${CH.blue}" stroke-width="2.4"/>`;
  rs.forEach((r,i)=>{ const [st,bad]=statusOf(r,X), tail=r.cruise.tail/KT, wy=H-pb+56, bh=Math.abs(tail)/maxW*14;
    g+=`<circle cx="${cx(i)}" cy="${yt(times[i])}" r="3.5" fill="${CH.amber}"><title>${lvl(r.ft)}: ${hhmm(r.time)}</title></circle>
      <circle cx="${cx(i)}" cy="${yf(fuels[i])}" r="${r===X.best?6:4.5}" fill="${bad?CH.dim:r===X.best?CH.green:CH.blue}" stroke="${CH.halo}" stroke-width="1.5"><title>${lvl(r.ft)}: ${fmtK(fuels[i])} ${unit}, ${hhmm(r.time)}, wind ${tail>=0?"+":""}${Math.round(tail)} kt — ${svgEsc(st)}</title></circle>
      <text x="${cx(i)}" y="${H-pb+16}" font-size="11" fill="${bad?CH.axis:CH.text}" text-anchor="middle">${r.ft>=18000?"FL"+Math.round(r.ft/100):(r.ft/1000).toFixed(1).replace(/\.0$/,"")+"k"}</text>
      <text x="${cx(i)}" y="${H-pb+32}" font-size="10.5" font-weight="700" fill="${tail>=0?CH.green:CH.red}" text-anchor="middle">${tail>=0?"+":""}${Math.round(tail)}</text>
      <rect x="${cx(i)-Math.min(step*0.3,9)}" y="${tail>=0?wy-bh:wy}" width="${Math.min(step*0.6,18)}" height="${Math.max(bh,1)}" fill="${tail>=0?CH.green:CH.red}" opacity=".75"/>`; });
  g+=`<line x1="${pl}" x2="${W-pr}" y1="${H-pb+56}" y2="${H-pb+56}" stroke="${CH.grid}"/>
    <text x="${pl-8}" y="${H-pb+16}" font-size="10.5" fill="${CH.axis}" text-anchor="end">level</text>
    <text x="${pl-8}" y="${H-pb+32}" font-size="10.5" fill="${CH.axis}" text-anchor="end">wind kt</text>
    <text x="${pl-8}" y="${pt-8}" font-size="11" fill="${CH.blue}" text-anchor="end">fuel ${unit}</text>
    <text x="${W-pr+8}" y="${pt-8}" font-size="11" fill="${CH.amber}">time</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Trip fuel and time by cruise level">
    <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="color-mix(in srgb, var(--text) 2%, transparent)"/><line x1="0" y1="0" x2="0" y2="8" stroke="color-mix(in srgb, var(--text) 7%, transparent)" stroke-width="3"/></pattern></defs>${g}</svg>
    <div class="chartkey"><span><i style="background:${CH.blue}"></i>trip fuel</span><span><i style="background:${CH.amber}"></i>flight time</span><span><i style="background:${CH.green}"></i>optimum</span><span><i class="hatchkey"></i>excluded (terrain, MEA, oxygen, ceiling)</span><span class="note">hover a dot for details</span></div>`;
}

/* ---------------------------------------------------------------- 3 · runway diagram with wind */
function runwayDiagram(B){
  const ends=B.ends; if(!ends.length) return "";
  const S=250, c=S/2, R=98, met=B.met;
  // project runway ends to a local plane (feet), true north up
  const pts=[]; for(const x of ends) if(x.e.lat!=null&&x.e.lon!=null) pts.push(x.e);
  const lat0=pts.length?pts.reduce((s,p)=>s+p.lat,0)/pts.length:B.a.lat, lon0=pts.length?pts.reduce((s,p)=>s+p.lon,0)/pts.length:B.a.lon;
  const P=(lat,lon)=>[(lon-lon0)*Math.cos(rad(lat0))*364567,(lat-lat0)*364567];
  const runways=[...new Set(ends.map(x=>x.r))];
  const segs=runways.map(r=>{ const [a,b]=r.ends;
    if(a.lat!=null&&b.lat!=null) return {r,a:P(a.lat,a.lon),b:P(b.lat,b.lon)};
    const h=rad(ends.find(x=>x.r===r).e.hdgT??0), L=(r.length||5000)/2;     // no coordinates: draw through the centre by heading
    return {r,a:[-Math.sin(h)*L,-Math.cos(h)*L],b:[Math.sin(h)*L,Math.cos(h)*L]}; });
  const ext=Math.max(1,...segs.flatMap(s=>[Math.hypot(...s.a),Math.hypot(...s.b)]));
  const k=(R-26)/ext, T=([px,py])=>[c+px*k,c-py*k];
  let g=`<circle cx="${c}" cy="${c}" r="${R}" fill="var(--field)" stroke="${CH.grid}"/>`;
  for(let d=0;d<360;d+=30){ const a=rad(d), r1=d%90?R-5:R-9;
    g+=`<line x1="${c+Math.sin(a)*r1}" y1="${c-Math.cos(a)*r1}" x2="${c+Math.sin(a)*R}" y2="${c-Math.cos(a)*R}" stroke="${CH.axis}" stroke-width="${d%90?1:1.5}"/>`; }
  g+=["N","E","S","W"].map((t,i)=>{ const a=rad(i*90); return `<text x="${c+Math.sin(a)*(R+11)}" y="${c-Math.cos(a)*(R+11)+4}" font-size="11" fill="${CH.axis}" text-anchor="middle">${t}</text>`; }).join("");
  for(const s of segs){ const [x1,y1]=T(s.a), [x2,y2]=T(s.b), isBest=B.best&&B.best.r===s.r, wpx=Math.max(4,Math.min(10,(s.r.width||100)*k*1.4));
    g+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isBest?"color-mix(in oklch, var(--good) 45%, var(--field))":"var(--line-strong)"}" stroke-width="${wpx+3}" stroke-linecap="butt"/>
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isBest?CH.green:"var(--text-3)"}" stroke-width="${wpx}" stroke-linecap="butt"/>`;
    // runway number beyond each threshold
    const [ea,eb]=s.r.ends, dx=x2-x1, dy=y2-y1, L=Math.hypot(dx,dy)||1, ux=dx/L, uy=dy/L;
    for(const [e,px,py,sg] of [[ea,x1,y1,-1],[eb,x2,y2,1]]){ const best=B.best&&B.best.e.id===e.id;
      g+=`<text x="${px+ux*sg*13}" y="${py+uy*sg*13+4}" font-size="11" font-weight="700" fill="${best?CH.green:CH.text}" text-anchor="middle" stroke="var(--field)" stroke-width="3" paint-order="stroke">${e.id}</text>`; } }
  // wind arrow (from the reported direction toward the field)
  if(met&&met.wspd&&met.wdir!=null){
    const a=rad(met.wdir), x0=c+Math.sin(a)*(R-2), y0=c-Math.cos(a)*(R-2), x1=c+Math.sin(a)*34, y1=c-Math.cos(a)*34;
    g+=`<defs><marker id="wah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${CH.amber}"/></marker></defs>
      <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${CH.amber}" stroke-width="3.5" marker-end="url(#wah)"/>
      <text x="${c+Math.sin(a)*(R-22)+(Math.sin(a)>=0?8:-8)}" y="${c-Math.cos(a)*(R-22)+(Math.cos(a)>=0?-8:14)}" font-size="11.5" font-weight="700" fill="${CH.amber}" text-anchor="${Math.sin(a)>=0?"start":"end"}" stroke="var(--field)" stroke-width="3" paint-order="stroke">${fmtBrg(met.wdir)}°/${met.wspd}${met.wgst?"G"+met.wgst:""}</text>`;
  } else g+=`<text x="${c}" y="${c+R-16}" font-size="11.5" font-weight="700" fill="${CH.amber}" text-anchor="middle">${met?(met.vrb?`VRB ${met.wspd} kt`:"CALM"):"no wind report"}</text>`;
  return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Runway diagram with wind" class="rwydiag">${g}</svg>`;
}

/* ---------------------------------------------------------------- distance required vs available */
function distanceBars(B){
  const rows=B.ends.filter(x=>x.perf).sort((p,q)=>(q===B.best)-(p===B.best)||p.e.id.localeCompare(q.e.id,undefined,{numeric:true}));
  if(!rows.length) return "";
  const phase=B.role==="Departure"?"Takeoff":"Landing", max=Math.max(...rows.map(x=>Math.max(x.perf.avail,x.perf.fact)));
  const pct=v=>(v/max*100).toFixed(1);
  return `<div class="dbars"><div class="dbhead">${phase} distance required vs available</div>
    ${rows.map(x=>{ const p=x.perf, col={ok:CH.green,tight:CH.amber,no:CH.red}[p.status], wc=x.wc, met=B.met;
      const wind=met&&met.wspd&&!wc.vrb?`${wc.hw>=0?"H":"T"}${Math.abs(Math.round(wc.hw))} X${Math.abs(Math.round(wc.xw))}`:"";
      return `<div class="dbrow${x===B.best?" best":""}"><span class="dbid">${x.e.id}${x===B.best?" ★":""}</span>
        <span class="dbtrack" title="${fmtK(Math.round(p.fact/FT))} ft required (×SF) · ${fmtK(Math.round(p.req/FT))} ft unfactored · ${fmtK(Math.round(p.avail/FT))} ft available">
          <span class="dbavail" style="width:${pct(p.avail)}%"></span><span class="dbreq" style="width:${pct(Math.min(p.fact,max))}%;background:${col}"></span>
          <span class="dbraw" style="left:${pct(p.req)}%"></span></span>
        <span class="dbnum"><b style="color:${col}">${fmtK(Math.round(p.fact/FT))}</b> / ${fmtK(Math.round(p.avail/FT))} ft</span><span class="dbwind">${wind}</span></div>`; }).join("")}
    <div class="note">Bar = runway ${B.role==="Departure"?"length":"landing distance available"}; coloured fill = required with safety factor; white tick = unfactored.</div></div>`;
}

/* ---------------------------------------------------------------- 4 · fuel remaining along the route */
function fuelChart(X){
  const {sel,total,route,m}=X, apm=m.kind==="apm", fu=kg=>apm?kg/m.fuelDensity:kg, unit=apm?"gal":"kg";
  const W=1000,H=230,pl=64,pr=20,pt=40,pb=34, block=fu(sel.block), res=fu(sel.reserve), land=block-fu(sel.trip);
  const top=Math.ceil(block*1.08/(apm?5:500))*(apm?5:500);
  const x=d=>pl+d/total*(W-pl-pr), y=v=>H-pb-v/top*(H-pt-pb);
  const N=120, pts=[]; for(let i=0;i<=N;i++){ const d=total*i/N, p=profileAtX(sel,total,d); pts.push([x(d),y(block-fu(p.fuel))]); }
  const line=pts.map(p=>p.map(v=>v.toFixed(1)).join(",")).join(" ");
  let g="";
  const gstep=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000].find(s=>top/s<=6)||10000;
  for(let v=0;v<=top;v+=gstep) g+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="${CH.grid}"/><text x="${pl-8}" y="${y(v)+4}" font-size="11" fill="${CH.axis}" text-anchor="end">${fmtK(v)}</text>`;
  g+=`<rect x="${pl}" y="${y(res)}" width="${W-pl-pr}" height="${y(0)-y(res)}" fill="color-mix(in oklch, var(--bad) 12%, transparent)"/><line x1="${pl}" x2="${W-pr}" y1="${y(res)}" y2="${y(res)}" stroke="${CH.red}" stroke-dasharray="4 4"/>`;
  // stations / fixes along the route: a tick for each; names on two staggered rows, left out where they would still
  // overlap (SID/STAR clusters) — svg text is mono, so 10 px ≈ 6 px per character
  const rowEnd=[-Infinity,-Infinity];
  route.points.slice(1,-1).forEach((P,i)=>{ const d=route.legs[i].s0+route.legs[i].d, xx=x(d), lab=svgEsc(P.label), w=P.label.length*6;
    g+=`<line x1="${xx}" x2="${xx}" y1="${pt}" y2="${H-pb}" stroke="var(--line-soft)"><title>${lab} · ${fmtK(Math.round(nm(d)))} NM</title></line>`;
    const cx=Math.max(pl+w/2,Math.min(W-pr-w/2,xx)), row=rowEnd.findIndex(e=>cx-w/2>=e+8);
    if(row<0) return; rowEnd[row]=cx+w/2;
    g+=`<text x="${cx}" y="${pt-8-row*13}" font-size="10" fill="${CH.axis}" text-anchor="middle">${lab}</text>`; });
  g+=`<text x="${pl+6}" y="${y(res)+14}" font-size="11" fill="${CH.red}" stroke="${CH.halo}" stroke-width="3" paint-order="stroke">reserve ${fmtK(res)} ${unit} (${sel.reserveNote})</text>`;
  g+=`<polygon points="${x(0)},${y(0)} ${line} ${x(total)},${y(0)}" fill="color-mix(in srgb, var(--accent) 13%, transparent)"/><polyline points="${line}" fill="none" stroke="${CH.blue}" stroke-width="2.4"/>`;
  for(const [k,d,col] of [["TOC",sel.climb.d,CH.green],["TOD",total-sel.descent.d,CH.magenta]]){ const p=profileAtX(sel,total,d), v=block-fu(p.fuel);
    g+=`<circle cx="${x(d)}" cy="${y(v)}" r="4.5" fill="${col}"><title>${k}: ${fmtK(v)} ${unit} left</title></circle>`; }
  g+=`<text x="${x(0)+6}" y="${y(block)-6}" font-size="11.5" fill="${CH.text}" stroke="${CH.halo}" stroke-width="3" paint-order="stroke">block ${fmtK(block)} ${unit}</text>
    <circle cx="${x(total)}" cy="${y(land)}" r="5" fill="${land>=res*0.999?CH.green:CH.red}"/>
    <text x="${x(total)-8}" y="${y(land)-10}" font-size="11.5" font-weight="700" fill="${land>=res*0.999?CH.green:CH.red}" text-anchor="end" stroke="${CH.halo}" stroke-width="3" paint-order="stroke">land with ${fmtK(land)} ${unit}</text>
    <text x="${pl}" y="${H-6}" font-size="11" fill="${CH.text}">${X.dep.icao}</text><text x="${W-pr}" y="${H-6}" font-size="11" fill="${CH.text}" text-anchor="end">${X.arr.icao}</text>
    <text x="${(W+pl)/2}" y="${H-6}" font-size="11" fill="${CH.axis}" text-anchor="middle">distance (NM) · ${fmtK(nm(total))} NM</text>
    <text x="${pl-8}" y="${pt-12}" font-size="11" fill="${CH.axis}" text-anchor="end">${unit}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Fuel remaining along the route">${g}</svg>`;
}

/* ---------------------------------------------------------------- 5 · TAF flight-category timeline */
function visSM(v){ if(v==null) return null; if(typeof v==="number") return v; const s=String(v).replace("+","").trim();
  if(/^\d+\s+\d+\/\d+$/.test(s)){ const [w,f]=s.split(/\s+/); const [a,b]=f.split("/"); return +w+a/b; }
  if(/^\d+\/\d+$/.test(s)){ const [a,b]=s.split("/"); return a/b; } const n=parseFloat(s); return isNaN(n)?null:n; }
function ceilingOf(clouds,vv){ const c=(clouds||[]).filter(l=>/BKN|OVC|OVX/.test(l.cover)&&l.base!=null).map(l=>l.base); if(vv!=null) c.push(vv); return c.length?Math.min(...c):null; }
function flightCat(vis,ceil){ if((ceil!=null&&ceil<500)||(vis!=null&&vis<1)) return "LIFR"; if((ceil!=null&&ceil<1000)||(vis!=null&&vis<3)) return "IFR";
  if((ceil!=null&&ceil<=3000)||(vis!=null&&vis<=5)) return "MVFR"; return "VFR"; }
function tafPeriods(wx){
  const F=wx?.tafFcsts; if(!F||!F.length) return null;
  const from=wx.tafValid?.[0]??F[0].timeFrom, to=wx.tafValid?.[1]??Math.max(...F.map(f=>f.timeTo));
  const base=[], over=[]; let st={vis:null,ceil:null,clouds:null,wx:null,wind:""};
  const wind=f=>f.wspd!=null?`${f.wdir==="VRB"?"VRB":fmtBrg(f.wdir)}/${f.wspd}${f.wgst?"G"+f.wgst:""}`:"";
  for(const f of F.slice().sort((a,b)=>a.timeFrom-b.timeFrom)){
    const ch=f.fcstChange||"";
    const vis=visSM(f.visib), clouds=f.clouds&&f.clouds.length?f.clouds:null;
    if(ch==="TEMPO"||ch.startsWith("PROB")||f.probability){
      const v=vis??st.vis, ce=clouds||f.vertVis!=null?ceilingOf(clouds,f.vertVis):st.ceil;
      over.push({t0:f.timeFrom,t1:f.timeTo,cat:flightCat(v,ce),kind:ch||`PROB${f.probability}`,wx:f.wxString,wind:wind(f),vis:v,ceil:ce});
    } else {
      st={vis:vis??st.vis,ceil:clouds||f.vertVis!=null?ceilingOf(clouds,f.vertVis):st.ceil,wx:f.wxString,wind:wind(f)||st.wind};
      base.push({t0:f.timeFrom,cat:flightCat(st.vis,st.ceil),kind:ch||"",wx:st.wx,wind:st.wind,vis:st.vis,ceil:st.ceil});
    }
  }
  base.forEach((b,i)=>b.t1=i+1<base.length?base[i+1].t0:to);
  return {from,to,base,over};
}
function tafTimeline(B,etaDate,label){
  const T=tafPeriods(B.wx); if(!T) return "";
  const W=1000,H=86,pl=64,pr=20, now=Date.now()/1000, t0=Math.max(T.from,Math.min(now,T.to)-3600*2), t1=T.to;
  if(t1<=t0) return "";
  const x=t=>pl+(Math.min(Math.max(t,t0),t1)-t0)/(t1-t0)*(W-pl-pr);
  const desc=p=>`${p.kind?p.kind+" ":""}${new Date(p.t0*1000).toISOString().slice(11,16)}–${new Date(p.t1*1000).toISOString().slice(11,16)}Z: ${p.cat} · vis ${p.vis??"—"} SM · ceiling ${p.ceil!=null?fmtK(p.ceil)+" ft":"none"}${p.wind?" · wind "+p.wind:""}${p.wx?" · "+p.wx:""}`;
  let g="";
  for(const p of T.base) if(p.t1>t0) g+=`<rect x="${x(p.t0)}" y="18" width="${Math.max(1,x(p.t1)-x(p.t0)-1)}" height="24" rx="3" fill="${CAT_COL[p.cat]}" opacity=".85"><title>${svgEsc(desc(p))}</title></rect>`;
  for(const p of T.over) if(p.t1>t0) g+=`<rect x="${x(p.t0)}" y="46" width="${Math.max(1,x(p.t1)-x(p.t0)-1)}" height="12" rx="2" fill="${CAT_COL[p.cat]}" opacity=".75"><title>${svgEsc(desc(p))}</title></rect>
    <text x="${x(p.t0)+3}" y="55.5" font-size="9" fill="var(--cat-ink)">${svgEsc(p.kind)}</text>`;
  g+=`<text x="${pl-8}" y="34" font-size="10.5" fill="${CH.axis}" text-anchor="end">forecast</text><text x="${pl-8}" y="56" font-size="10.5" fill="${CH.axis}" text-anchor="end">tempo</text>`;
  for(let t=Math.ceil(t0/10800)*10800;t<=t1;t+=10800) g+=`<line x1="${x(t)}" x2="${x(t)}" y1="14" y2="62" stroke="color-mix(in srgb, var(--bg) 50%, transparent)"/><text x="${x(t)}" y="76" font-size="10" fill="${CH.axis}" text-anchor="middle">${new Date(t*1000).toISOString().slice(11,13)}Z</text>`;
  if(now>t0&&now<t1) g+=`<line x1="${x(now)}" x2="${x(now)}" y1="12" y2="64" stroke="${CH.axis}" stroke-dasharray="2 3"/><text x="${x(now)}" y="10" font-size="9.5" fill="${CH.axis}" text-anchor="middle">now</text>`;
  // verdict at ETD / ETA
  let verdict="";
  if(etaDate){ const te=etaDate.getTime()/1000, xe=x(te), inRange=te>=T.from&&te<=T.to;
    if(te>=t0&&te<=t1) g+=`<line x1="${xe}" x2="${xe}" y1="10" y2="66" stroke="${CH.text}" stroke-width="2"/><text x="${xe}" y="9" font-size="10.5" font-weight="700" fill="${CH.text}" text-anchor="middle">${label} ${etaDate.toISOString().slice(11,16)}Z</text>`;
    if(inRange){ const b=T.base.find(p=>te>=p.t0&&te<p.t1), o=T.over.filter(p=>te>=p.t0&&te<p.t1);
      verdict=`At ${label} ${etaDate.toISOString().slice(11,16)}Z: <b style="color:${CAT_COL[b?.cat]||CH.text}">${b?.cat||"—"}</b>${b?.wind?` · wind ${b.wind}`:""}${o.length?` · <span style="color:${CAT_COL[o[0].cat]}">${o.map(p=>p.kind+" "+p.cat+(p.wx?" "+p.wx:"")).join(", ")} possible</span>`:""}`; }
    else verdict=`${label} ${etaDate.toISOString().slice(11,16)}Z is outside the TAF period.`; }
  return `<div class="taftl"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="TAF flight category timeline">${g}</svg>
    <div class="note">${verdict?verdict+" · ":""}<span style="color:${CAT_COL.VFR}">VFR</span> <span style="color:${CAT_COL.MVFR}">MVFR</span> <span style="color:${CAT_COL.IFR}">IFR</span> <span style="color:${CAT_COL.LIFR}">LIFR</span> · hover for details${B.wx.station&&B.wx.station!==B.a.icao?` · TAF from ${B.wx.station}`:""}</div></div>`;
}
