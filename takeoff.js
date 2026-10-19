"use strict";
/* =====================================================================
   Takeoff & landing view. Departure side: V1/VR/V2, reduced-thrust temperature, flaps and required vs available
   runway for the departure runway chosen in FS2024 setup. Arrival side: VREF/VAPP, suggested autobrake and landing
   distance (dispatch and at arrival) for the runway of the approach chosen in FS2024 setup. Inputs come from the plan
   and the METARs; the model is toperf.js; per-type data comes from data/to_ref.json + data/to_tune.json through XD.
   Airliners (OpenAP) only. Also the Overview tile and the FS2024-setup boxes that summarise it. For simulation only.
   ===================================================================== */
const TO_OPTS_KEY="xperf.to.opts", TO_OPT_DEFAULTS={flap:"optimum",thrust:"reduced",packs:true,antiIce:"off"};
const LD_OPTS_KEY="xperf.ldg.opts", LD_OPT_DEFAULTS={flap:"default",autobrake:"suggested",reverse:"idle"}, TO_SIDE_KEY="xperf.to.side";
let TO_DATA=null;   // {ref, tune} | {error}
// loaded once the page's scripts have all run (XD's fetch helper lives in index.html's inline script)
if(typeof document!=="undefined") document.addEventListener("DOMContentLoaded",()=>{
  Promise.all([XD.toRef(),XD.toTune()]).then(([r,t])=>{ TO_DATA={ref:r.types,tune:t.types}; },e=>{ TO_DATA={error:e.message||String(e)}; })
    .then(()=>{ if(window.LAST_X&&typeof render==="function"){ const y=scrollY; render(window.LAST_X); scrollTo(0,y); } });   // tile + setup row too
});

function toOpts(){ let o={}; try{ o=JSON.parse(localStorage.getItem(TO_OPTS_KEY)||"{}")||{}; }catch(_){}
  return {...TO_OPT_DEFAULTS,...o}; }
function setToOpt(k,v){ const o=toOpts(); o[k]=v; try{ localStorage.setItem(TO_OPTS_KEY,JSON.stringify(o)); }catch(_){} }
function ldOpts(){ let o={}; try{ o=JSON.parse(localStorage.getItem(LD_OPTS_KEY)||"{}")||{}; }catch(_){}
  return {...LD_OPT_DEFAULTS,...o}; }
function setLdOpt(k,v){ const o=ldOpts(); o[k]=v; try{ localStorage.setItem(LD_OPTS_KEY,JSON.stringify(o)); }catch(_){} }
function toSide(){ try{ return localStorage.getItem(TO_SIDE_KEY)==="arr"?"arr":"dep"; }catch(_){ return "dep"; } }

// typed values outside these ranges are ignored (the plan value stays); keys set per runway live in overrides.byRwy[id]
const TO_RANGES={towKg:[1,2e6],lwKg:[1,2e6],lengthFt:[1,25000],ldaFt:[1,25000],elevFt:[-1500,15000],slopePct:[-5,5],oat:[-60,60],qnh:[850,1100],
  windKt:[-60,60],gustKt:[0,60],intersectionFt:[0,25000]};
const TO_RWY_KEYS=new Set(["lengthFt","elevFt","slopePct","windKt","intersectionFt","lineup"]), LD_RWY_KEYS=new Set(["ldaFt","elevFt","slopePct","windKt","gustKt"]);
const toValid=(k,v)=>{ const r=TO_RANGES[k]; return !r||(typeof v==="number"&&v>=r[0]&&v<=r[1]); };

// Plan → model input. end = a runway end from airportBrief() ({r,e,o}); overrides = values typed in the view.
function toInputs(X,end,overrides,opts){
  const B=X.briefs.dep, met=B.met||null, src={}, o0=overrides||{};
  const ov={...o0,...(o0.byRwy?.[end.e.id]||{})}; delete ov.byRwy;
  for(const k of Object.keys(ov)) if(!toValid(k,ov[k])) delete ov[k];
  const elev=end.e.elev??B.a.alt??0, stamp=met?.raw?.match(/\b\d{2}(\d{4})Z\b/)?.[1];
  const metSrc=met?`METAR ${stamp?stamp+"Z":""}`.trim():"assumed — no METAR";
  const hw=met&&!met.vrb&&met.wdir!=null&&met.wspd?met.wspd*Math.cos((met.wdir-(end.e.hdgT??0))*Math.PI/180):0;
  const slope=end.o?.elev!=null&&end.e.elev!=null&&end.r.length?(end.o.elev-end.e.elev)/end.r.length*100:0;
  const base={
    towKg:[X.sel.tow,"plan"], lengthFt:[end.r.length,"setup"], elevFt:[elev,"runway ends"], slopePct:[slope,"runway ends"],
    oat:[met?.temp??Math.round(TOPerf.isaAt(elev)),metSrc], qnh:[met?.qnh??1013.25,metSrc], windKt:[hw,metSrc], wet:[!!met?.wet,metSrc]};
  const input={};
  for(const [k,[v,s]] of Object.entries(base)){ const o=ov[k]; input[k]=o!=null&&o!==""?o:v; src[k]=o!=null&&o!==""?"edited":s; }
  Object.assign(input,{intersectionFt:ov.intersectionFt||0, lineup:ov.lineup||"none",
    packs:opts.packs!==false, antiIce:opts.antiIce||"off", thrust:opts.thrust||"reduced", flap:opts.flap||"optimum"});
  return {input,src};
}

// Everything the view, tile and setup row show; null-free states for GA, loading, errors and missing runways.
function takeoffResult(X){
  const m=X.m; if(!m||m.kind!=="openap") return {ga:true};
  if(!TO_DATA) return {pending:true};
  if(TO_DATA.error) return {error:"Takeoff data unavailable: "+TO_DATA.error};
  const B=X.briefs?.dep; if(!B||B.missing||!B.ends?.length) return {norunway:true};
  const ref=TO_DATA.ref[m.code]; if(!ref) return {error:`No takeoff reference data for ${String(m.code).toUpperCase()}.`};
  const end=chosenDepRunway(B), state=X.toState||(X.toState={overrides:{}}), opts=toOpts();
  const ac=TOPerf.acFromModel(m,ref,TO_DATA.tune[m.code]||null), {input,src}=toInputs(X,end,state.overrides,opts);
  return {ac,input,src,opts,end,B,result:TOPerf.compute(ac,input)};
}

// Plan → landing model input for an arrival runway end ({r,e,o}); overrides = values typed on the arrival side.
function toLandingInputs(X,end,overrides,opts){
  const B=X.briefs.arr, met=B.met||null, src={}, o0=overrides||{};
  const ov={...o0,...(o0.byRwy?.[end.e.id]||{})}; delete ov.byRwy;
  for(const k of Object.keys(ov)) if(!toValid(k,ov[k])) delete ov[k];
  const elev=end.e.elev??B.a.alt??0, stamp=met?.raw?.match(/\b\d{2}(\d{4})Z\b/)?.[1];
  const metSrc=met?`METAR ${stamp?stamp+"Z ":""}(now)`:"assumed — no METAR";
  const hw=met&&!met.vrb&&met.wdir!=null&&met.wspd?met.wspd*Math.cos((met.wdir-(end.e.hdgT??0))*Math.PI/180):0;
  const gust=met&&met.wgst&&met.wspd?Math.max(0,met.wgst-met.wspd):0;
  const slope=end.o?.elev!=null&&end.e.elev!=null&&end.r.length?(end.o.elev-end.e.elev)/end.r.length*100:0;
  const base={
    lwKg:[X.sel.land,"plan"], ldaFt:[Math.max(0,end.r.length-(end.e.dthr||0)),"setup"], elevFt:[elev,"runway ends"], slopePct:[slope,"runway ends"],
    oat:[met?.temp??Math.round(TOPerf.isaAt(elev)),metSrc], qnh:[met?.qnh??1013.25,metSrc], windKt:[hw,metSrc], gustKt:[gust,metSrc], wet:[!!met?.wet,metSrc]};
  const input={};
  for(const [k,[v,s]] of Object.entries(base)){ const o=ov[k]; input[k]=o!=null&&o!==""?o:v; src[k]=o!=null&&o!==""?"edited":s; }
  Object.assign(input,{reverse:opts.reverse||"idle", flap:opts.flap||"default", autobrake:opts.autobrake||"suggested"});
  return {input,src};
}

// the landing options that actually apply to this type: a flap or autobrake name saved on another type falls back
function ldEffective(ac,input){
  const f=ac.landingFlaps.find(x=>x.name===input.flap);
  return {flap:f&&!f.default?f.name:"default", autobrake:ac.autobrake.some(a=>a.name===input.autobrake)?input.autobrake:"suggested"};
}

// Everything the arrival side, tile and setup box show. Runway = the approach chosen in FS2024 setup, else the best one.
function landingResult(X){
  const m=X.m; if(!m||m.kind!=="openap") return {ga:true};
  if(!TO_DATA) return {pending:true};
  if(TO_DATA.error) return {error:"Landing data unavailable: "+TO_DATA.error};
  const B=X.briefs?.arr; if(!B||B.missing||!B.ends?.length) return {norunway:true};
  const ref=TO_DATA.ref[m.code]; if(!ref) return {error:`No landing reference data for ${String(m.code).toUpperCase()}.`};
  const ap=chosenApproach(B).sel, end=chosenArrRunway(B); if(!end) return {norunway:true};
  const state=X.toState||(X.toState={overrides:{}}), ov=state.ldg||(state.ldg={}), opts=ldOpts();
  const ac=TOPerf.acFromModel(m,ref,TO_DATA.tune[m.code]||null), {input,src}=toLandingInputs(X,end,ov,opts);
  return {ac,input,src,opts,end,B,approach:ap,result:TOPerf.computeLanding(ac,input)};
}

/* ---------------------------------------------------------------- rendering */
const toFt=(ft,cls="")=>`<span class="num ${cls}">${fmtK(ft)} ft</span> <span class="note num">· ${fmtK(ft*0.3048)} m</span>`;
const toKt=v=>Math.round(v), toFtTxt=v=>Number.isFinite(v)?fmtK(v):"—";   // Infinity = cannot accelerate / climb on one engine
function toTempTxt(T,sel){ return sel.assumedT!=null?`${T.ac.label} ${sel.assumedT}°`:T.ac.family==="airbus"?"TOGA":"Full thrust"; }
function toStatusHtml(T){ const r=T.result, s=r.selected;
  if(r.status==="nofit"&&!Number.isFinite(s.requiredFt)) return `<span class="bad">Does not fit — on one engine the aircraft cannot accelerate or climb at this weight</span>`;
  if(r.status==="nofit") return s.requiredFt>s.availableFt?`<span class="bad">Does not fit — short by ${fmtK(r.shortfallFt)} ft</span>`
    :`<span class="bad">Does not fit — one-engine-out climb ${(s.grad2*100).toFixed(1)} % below ${(s.grad2Min*100).toFixed(1)} %</span>`;
  if(r.status==="toga") return `<span class="warn">${T.input.thrust==="full"?"Full thrust selected":"No reduced thrust possible"} — ${T.ac.family==="airbus"?"TOGA":"full rated thrust"}</span>`;
  return `<span class="good">Reduced thrust: ${toTempTxt(T,s)} · thrust −${Math.round(s.thrustRed*100)} %</span>`; }

function toRunwayBar(T){
  const s=T.result.selected, len=T.input.lengthFt, used=Math.max(0,len-s.availableFt);
  const fin=[len,used+s.goFt,used+s.stopFt,used+s.requiredFt].filter(Number.isFinite);
  const span=Math.max(...fin)*1.03, X=ft=>(Math.min(ft,span)/span*1000).toFixed(1);   // an infinite distance runs off the end
  const end=used+s.requiredFt, over=s.requiredFt>s.availableFt;
  return `<svg class="to-rwy" viewBox="0 0 1000 78" preserveAspectRatio="none" role="img" aria-label="Runway ${svgEsc(T.end.e.id)}: ${toFtTxt(s.requiredFt)} ft required of ${fmtK(s.availableFt)} ft available">
    <defs><pattern id="toHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="var(--line-strong)"/></pattern></defs>
    <rect x="0" y="24" width="${X(len)}" height="18" rx="3" fill="var(--active)"/>
    ${used?`<rect x="0" y="24" width="${X(used)}" height="18" fill="url(#toHatch)"/>`:""}
    <rect x="${X(used)}" y="48" width="${X(s.goFt)}" height="5" rx="2" fill="var(--accent)"/>
    <rect x="${X(used)}" y="57" width="${X(s.stopFt)}" height="5" rx="2" fill="var(--text-3)"/>
    <line x1="${X(used+s.v1Ft)}" x2="${X(used+s.v1Ft)}" y1="20" y2="46" stroke="var(--text-2)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="${X(end)}" x2="${X(end)}" y1="14" y2="66" stroke="${over?"var(--bad)":"var(--text)"}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="to-rwy-labels num"><span style="left:${X(used+s.v1Ft)/10}%">V1</span><span style="left:${Math.min(X(end)/10,88)}%">${toFtTxt(s.requiredFt)} ft required</span></div>`;
}

// form controls for one side: ns "to" (departure) or "ld" (arrival) → data-to / data-ld, data-to-opt / data-ld-opt, …-reset
const toField=(ns,src)=>(k,label,val,unit)=>`<label class="to-field"><span class="k">${label}</span>
      <span class="to-inrow"><input class="num" data-${ns}="${k}" inputmode="decimal" value="${val}" aria-label="${label}"><span class="u">${unit}</span></span>
      <span class="to-src">${src[k]==="edited"?`edited · <button class="to-reset" data-${ns}-reset="${k}">reset</button>`:svgEsc(src[k]||"")}</span></label>`;
const toSeg=ns=>(key,label,items,cur)=>`<div class="to-opt"><span class="k">${label}</span><div class="seg" role="group" aria-label="${label}">${items.map(([v,t])=>
      `<button type="button" data-${ns}-opt="${key}" data-v="${svgEsc(v)}" aria-pressed="${String(cur)===String(v)}">${svgEsc(t)}</button>`).join("")}</div></div>`;
const toBig=(k,v,u,cls="",sub="")=>`<div class="to-stat"><div class="k">${k}</div><div class="v num ${cls}">${v}${u?`<small>${u}</small>`:""}</div>${sub?`<div class="s">${sub}</div>`:""}</div>`;
const toMsg=t=>`<div class="card"><p class="note">${t}</p></div>`;

// header with the Departure / Arrival switch, then that side
function takeoffView(X){
  const T=X.takeoff, L=X.landing, side=toSide();
  const head=`<div class="to-head"><h2 class="viewtitle">Takeoff &amp; landing</h2>`;
  if(!T||T.ga) return head+`</div>`+toMsg(`Takeoff and landing data are for airliners. For this aircraft see the runway checks in <a href="#airports" data-open="airports">Airports &amp; weather</a>.`);
  const lab=(R,apt)=>R?.end?`${svgEsc(apt.icao)} ${svgEsc(R.end.e.id)}`:svgEsc(apt.icao);
  const sw=`<div class="seg to-side" role="group" aria-label="Departure or arrival">
      <button type="button" data-to-side="dep" aria-pressed="${side==="dep"}">Takeoff · ${lab(T,X.dep)}</button>
      <button type="button" data-to-side="arr" aria-pressed="${side==="arr"}">Landing · ${lab(L,X.arr)}</button></div>`;
  const R=side==="arr"?L:T, tuned=R?.result?.tuned;
  const badges=R?.result?`<span class="badge warn">XPerf estimate · for simulation only</span>${tuned?`<span class="badge ok">tuned to ${R.ac.family==="airbus"?"Airbus":"Boeing"} airport-planning charts</span>`:""}`:"";
  return head+sw+badges+`</div>`+(side==="arr"?landingBody(X):takeoffBody(X));
}

function takeoffBody(X){
  const T=X.takeoff;
  if(T.pending) return toMsg("Loading takeoff data…");
  if(T.error) return toMsg(svgEsc(T.error));
  if(T.norunway) return toMsg("No runway data for the departure airport — takeoff data needs a runway.");
  const {ac,input,src,result:r,end,B}=T, s=r.selected, ov=X.toState.overrides, code=String(X.m.code).toUpperCase();
  const field=toField("to",src), seg=toSeg("to");
  const wetCur=ov.wet!=null?ov.wet:input.wet;
  const inputs=`<div class="to-box"><h3>From your plan <span class="note">edit any value</span></h3>
      <div class="to-ac"><b>${svgEsc(X.m.label||code)}</b> <span class="note">${svgEsc(ac.engine||"")} · OpenAP</span></div>
      <label class="to-field wide"><span class="k">Runway</span>${runwaySelect(B,end)}<span class="to-src">same choice as FS2024 setup</span></label>
      ${field("towKg","Takeoff weight",Math.round(input.towKg),"kg")}
      ${field("lengthFt","Runway length",Math.round(input.lengthFt),"ft")}
      ${field("elevFt","Elevation",Math.round(input.elevFt),"ft")}
      ${field("slopePct","Slope (+ uphill)",(+input.slopePct).toFixed(2),"%")}
      ${field("oat","OAT",input.oat,"°C")}
      ${field("qnh","QNH",Math.round(input.qnh*10)/10,"hPa")}
      ${field("windKt","Headwind (− tail)",Math.round(input.windKt),"kt")}
      ${B.met?`<p class="note to-raw">${svgEsc(B.met.raw||"")}</p>`:`<p class="note">No METAR — standard atmosphere and calm wind assumed; type the actual values.</p>`}
    </div>
    <div class="to-box"><h3>Options</h3>
      ${seg("flap","Flaps",[["optimum","Optimum"],...ac.flaps.map(f=>[f.name,f.name])],T.opts.flap)}
      ${seg("thrust","Thrust",[["reduced",ac.label],["full",ac.family==="airbus"?"TOGA":"Full"]],T.opts.thrust)}
      ${seg("packs","Packs",[["true","On"],["false","Off"]],String(T.opts.packs!==false))}
      ${seg("antiIce","Anti-ice",[["off","Off"],["eng","Engine"],["wing","Engine + wing"]],T.opts.antiIce)}
      ${seg("wet","Runway",[["false","Dry"],["true","Wet"]],String(!!wetCur))}
      <div class="to-two">
        <label class="to-field"><span class="k">Intersection — runway behind you</span><span class="to-inrow"><input class="num" data-to="intersectionFt" inputmode="decimal" value="${input.intersectionFt||0}" aria-label="Runway behind you at the intersection"><span class="u">ft</span></span></label>
        <label class="to-field"><span class="k">Line-up</span><select data-to="lineup" aria-label="Line-up allowance">${[["none","None"],["90","90° turn"],["180","180° turn"]].map(([v,t])=>`<option value="${v}" ${input.lineup===v?"selected":""}>${t}</option>`).join("")}</select></label>
      </div>
    </div>`;
  const big=toBig;
  const results=`<div class="to-box"><h3>Takeoff data · RWY ${svgEsc(end.e.id)} <span class="note">${r.optimum===s.flap?`optimum flaps ${svgEsc(s.flap)}`:`flaps ${svgEsc(s.flap)} (optimum ${svgEsc(r.optimum)})`}</span></h3>
      <div class="to-big">
        ${big("V1",toKt(s.v1),"kt")}${big("VR",toKt(s.vr),"kt")}${big("V2",toKt(s.v2),"kt")}
        ${big(ac.label,s.assumedT!=null?s.assumedT:ac.family==="airbus"?"TOGA":"Full",s.assumedT!=null?"°C":"",s.assumedT!=null?"acc":r.status==="nofit"?"bad":"",
          s.assumedT!=null?`thrust −${Math.round(s.thrustRed*100)} %`:"")}
        ${big("Flaps",svgEsc(s.flap),"")}
      </div>
      <p class="to-status">${toStatusHtml(T)}</p>
      ${r.notes.map(n=>`<p class="note warn">${svgEsc(n)}</p>`).join("")}
    </div>
    <div class="to-box"><h3>Runway ${svgEsc(end.e.id)} <span class="note">${toFt(s.availableFt)} available</span></h3>
      ${toRunwayBar(T)}
      <div class="to-legend"><span><i style="background:var(--accent)"></i>Accelerate-go, one engine out, to ${input.wet?"15":"35"} ft · ${toFtTxt(s.goFt)} ft</span>
        <span><i style="background:var(--text-3)"></i>Accelerate-stop · ${toFtTxt(s.stopFt)} ft</span>
        ${s.availableFt<input.lengthFt?`<span><i class="hatch"></i>Behind you · ${fmtK(input.lengthFt-s.availableFt)} ft</span>`:""}
        <span>Margin <b class="num ${s.availableFt-s.requiredFt<0?"bad":""}">${toFtTxt(s.availableFt-s.requiredFt)} ft</b></span></div>
    </div>
    <div class="to-box"><h3>Limits checked</h3><div class="to-limits">
      ${s.limits.map(l=>`<span class="${l.ok?"good":"bad"}">●</span><span>${{field:"Field length (balanced V1)",grad2:"One-engine-out climb, 2nd segment",thrust:"Thrust reduction at most 25 %"}[l.id]}</span><span class="note num">${l.text}</span>`).join("")}
      <span class="warn">●</span><span>Obstacles, VMCG / VMBE / tyre speed</span><span class="note">not modelled</span></div></div>
    <div class="to-box"><h3>Every flap setting</h3><div class="tblwrap"><table><tr><th>Flaps</th><th>${svgEsc(ac.label)}</th><th>V1</th><th>VR</th><th>V2</th><th>Required ft</th><th>2nd seg</th></tr>
      ${r.byFlap.map(f=>`<tr class="${f===s?"pick":""}"><td>${svgEsc(f.flap)}${f.flap===r.optimum?" ★":""}</td><td>${f.assumedT!=null?f.assumedT+" °C":f.status==="nofit"?"—":"TOGA"}</td>
        <td>${toKt(f.v1)}</td><td>${toKt(f.vr)}</td><td>${toKt(f.v2)}</td><td class="${f.requiredFt>f.availableFt?"bad":""}">${toFtTxt(f.requiredFt)}</td><td>${(f.grad2*100).toFixed(1)} %</td></tr>`).join("")}</table></div></div>
    <div class="callout warn"><svg class="i"><use href="#i-alert"/></svg><div><b>Estimated with a generic jet model from OpenAP data${r.tuned?", field length tuned to the manufacturer's airport-planning charts":""}.</b>
      Speeds typically within ±5–8 kt and distances ±10–15 %${r.tuned?" (±5 % against the charts)":""}; not the manufacturer's takeoff tables. Trim is not computed. If your aircraft's EFB calculates takeoff data, use that.
      The runway check in Airports &amp; weather uses a simpler method, so its distances differ.</div></div>`;
  return `<div class="to-grid"><div class="to-col">${inputs}</div><div class="to-col">${results}</div></div>`;
}

const LD_LIMITS="Contaminated runway, autoland, brake energy, go-around climb";
function ldStatusHtml(L){ const r=L.result, s=r.selected;
  if(r.status==="nofit") return !r.suggested?`<span class="bad">Does not fit — no autobrake setting stops within the runway with the 15 % margin</span>`
    :`<span class="bad">Autobrake ${svgEsc(s.name)} does not fit — use ${svgEsc(r.suggested)} or higher</span>`;
  if(r.status==="tight") return `<span class="warn">Fits at arrival with ${svgEsc(s.name)}, but the runway is shorter than the dispatch requirement (${toFtTxt(r.dispatchFt)} ft)</span>`;
  return `<span class="good">Autobrake ${svgEsc(s.name)} stops in ${toFtTxt(s.actualFt)} ft (× 1.15 = ${toFtTxt(s.arrivalFt)} ft) of ${fmtK(r.ldaFt)} ft</span>`; }

function ldRunwayBar(L){
  const r=L.result, s=r.selected, lda=r.ldaFt;
  const fin=[lda,s.arrivalFt,r.dispatchFt].filter(Number.isFinite), span=Math.max(...fin,1)*1.03;
  const X=ft=>(Math.min(Math.max(ft,0),span)/span*1000).toFixed(1), over=s.arrivalFt>lda;
  return `<svg class="to-rwy" viewBox="0 0 1000 78" preserveAspectRatio="none" role="img" aria-label="Runway ${svgEsc(L.end.e.id)}: stops in ${toFtTxt(s.actualFt)} ft of ${fmtK(lda)} ft available">
    <rect x="0" y="24" width="${X(lda)}" height="18" rx="3" fill="var(--active)"/>
    <rect x="${X(r.airFt)}" y="48" width="${Math.max(0,X(s.actualFt)-X(r.airFt)).toFixed(1)}" height="5" rx="2" fill="var(--accent)"/>
    <rect x="0" y="48" width="${X(r.airFt)}" height="5" rx="2" fill="var(--line-strong)"/>
    <line x1="${X(s.arrivalFt)}" x2="${X(s.arrivalFt)}" y1="14" y2="66" stroke="${over?"var(--bad)":"var(--text)"}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <line x1="${X(r.dispatchFt)}" x2="${X(r.dispatchFt)}" y1="14" y2="66" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="to-rwy-labels num"><span style="left:${Math.min(X(r.airFt)/10,90)}%">TD</span><span style="left:${Math.min(X(s.arrivalFt)/10,88)}%">× 1.15</span></div>`;
}

function landingBody(X){
  const L=X.landing;
  if(!L||L.pending) return toMsg("Loading landing data…");
  if(L.error) return toMsg(svgEsc(L.error));
  if(L.norunway) return toMsg("No runway data for the arrival airport — landing data needs a runway.");
  const {ac,input,src,result:r,end,B,approach}=L, s=r.selected, ov=X.toState.ldg, code=String(X.m.code).toUpperCase();
  const field=toField("ld",src), seg=toSeg("ld"), wetCur=ov.wet!=null?ov.wet:input.wet, eff=ldEffective(ac,input);
  const rule=ac.vappRule==="airbus"?"headwind ÷ 3, 5–15 kt":"½ headwind + gust, 5–20 kt";
  const inputs=`<div class="to-box"><h3>From your plan <span class="note">edit any value</span></h3>
      <div class="to-ac"><b>${svgEsc(X.m.label||code)}</b> <span class="note">${svgEsc(ac.engine||"")} · OpenAP</span></div>
      <div class="to-field wide"><span class="k">Runway</span><span class="to-rwyname"><b>RWY ${svgEsc(end.e.id)}</b>${approach?` · ${svgEsc(approach.name)}`:""}</span>
        <span class="to-src">from the approach chosen in <a href="#setup" data-open="setup">FS2024 setup</a></span></div>
      ${field("lwKg","Landing weight",Math.round(input.lwKg),"kg")}
      ${field("ldaFt","Landing distance available",Math.round(input.ldaFt),"ft")}
      ${field("elevFt","Elevation",Math.round(input.elevFt),"ft")}
      ${field("slopePct","Slope (+ uphill)",(+input.slopePct).toFixed(2),"%")}
      ${field("oat","OAT",input.oat,"°C")}
      ${field("qnh","QNH",Math.round(input.qnh*10)/10,"hPa")}
      ${field("windKt","Headwind (− tail)",Math.round(input.windKt),"kt")}
      ${ac.vappRule==="airbus"?"":field("gustKt","Gust increment",Math.round(input.gustKt),"kt")}
      ${B.met?`<p class="note to-raw">${svgEsc(B.met.raw||"")}</p><p class="note">Current METAR — check the ATIS before landing.</p>`:`<p class="note">No METAR — standard atmosphere, calm wind and a dry runway assumed; type the expected values.</p>`}
    </div>
    <div class="to-box"><h3>Options</h3>
      ${seg("flap","Landing flaps",ac.landingFlaps.map(f=>[f.default?"default":f.name,f.name]),eff.flap)}
      ${seg("autobrake","Autobrake",[["suggested","Suggested"],...ac.autobrake.map(a=>[a.name,a.name])],eff.autobrake)}
      ${seg("reverse","Reversers",[["max","Max"],["idle","Idle"],["none","None"]],input.reverse)}
      ${seg("wet","Runway",[["false","Dry"],["true","Wet"]],String(!!wetCur))}
    </div>`;
  const results=`<div class="to-box"><h3>Landing data · RWY ${svgEsc(end.e.id)} <span class="note">flaps ${svgEsc(r.flap)}</span></h3>
      <div class="to-big">
        ${toBig("VREF",toKt(r.vref),"kt")}
        ${toBig("VAPP",toKt(r.vapp),"kt","acc",`<span title="Wind additive: ${rule}">+${toKt(r.additive)} kt additive</span>`)}
        ${toBig("Flaps",svgEsc(r.flap),"")}
        ${toBig("Autobrake",svgEsc(s.name),"",r.status==="nofit"?"bad":"",eff.autobrake!=="suggested"?"chosen":r.suggested?"suggested":"no setting fits")}
      </div>
      <p class="to-status">${ldStatusHtml(L)}</p>
      ${r.notes.map(n=>`<p class="note warn">${svgEsc(n)}</p>`).join("")}
    </div>
    <div class="to-box"><h3>Runway ${svgEsc(end.e.id)} <span class="note">${toFt(r.ldaFt)} available</span></h3>
      ${ldRunwayBar(L)}
      <div class="to-legend"><span><i style="background:var(--line-strong)"></i>Air distance from 50 ft · ${toFtTxt(r.airFt)} ft</span>
        <span><i style="background:var(--accent)"></i>Stop with ${svgEsc(s.name)} · ${toFtTxt(s.actualFt)} ft</span>
        <span><i class="dash"></i>Dispatch requirement · ${toFtTxt(r.dispatchFt)} ft</span>
        <span>Margin <b class="num ${r.ldaFt-s.arrivalFt<0?"bad":""}">${toFtTxt(r.ldaFt-s.arrivalFt)} ft</b></span></div>
    </div>
    <div class="to-box"><h3>Limits checked</h3><div class="to-limits">
      <span class="${r.dispatchOK?"good":"bad"}">●</span><span>Dispatch: max braking, no reverse, × 1.67${input.wet?" × 1.15 wet":""}</span><span class="note num">${toFtTxt(r.dispatchFt)} of ${fmtK(r.ldaFt)} ft</span>
      <span class="${s.fits?"good":"bad"}">●</span><span>At arrival: ${svgEsc(s.name)}, reversers ${svgEsc(input.reverse)}, × 1.15</span><span class="note num">${toFtTxt(s.arrivalFt)} of ${fmtK(r.ldaFt)} ft</span>
      <span class="warn">●</span><span>${LD_LIMITS}</span><span class="note">not modelled</span></div></div>
    <div class="to-box"><h3>Every autobrake setting</h3><div class="tblwrap"><table><tr><th>Autobrake</th><th>Decel m/s²</th><th>Stop ft</th><th>× 1.15 ft</th><th>Fits</th></tr>
      ${r.byAutobrake.map(a=>`<tr class="${a===s?"pick":""}"><td>${svgEsc(a.name)}${a.name===r.suggested?" ★":""}</td><td>${a.decel==null?"max":a.decel.toFixed(1)}</td>
        <td>${toFtTxt(a.actualFt)}</td><td class="${a.fits?"":"bad"}">${toFtTxt(a.arrivalFt)}</td><td class="${a.fits?"good":"bad"}">${a.fits?"yes":"no"}</td></tr>`).join("")}</table></div></div>
    <div class="callout warn"><svg class="i"><use href="#i-alert"/></svg><div><b>Estimated with a generic jet model from OpenAP data${r.tuned?", dispatch distance tuned to the manufacturer's airport-planning charts":""}.</b>
      Speeds typically within ±5 kt and distances ±10–15 %${r.tuned?" (dispatch ±5 % against the charts)":""}; autobrake rates are generic for the aircraft family. Not the manufacturer's landing tables.
      The runway check in Airports &amp; weather uses a simpler method, so its distances differ.</div></div>`;
  return `<div class="to-grid"><div class="to-col">${inputs}</div><div class="to-col">${results}</div></div>`;
}

/* ---------------------------------------------------------------- summaries (Overview tile, FS2024 setup row) */
// two halves: takeoff | landing; each half opens its side of the view (data-to-side), the tile opens the view
function takeoffTile(X){
  const T=X.takeoff, L=X.landing; if(!T||T.ga) return "";
  // a side without a result: what is missing, in the tile's own words
  const why=(R,what)=>R?.pending?`Loading ${what} data…`:R?.norunway?"No runway data":R?.error?svgEsc(R.error):"Not available";
  const side=(k,icon,title,body)=>`<div data-to-side="${k}"><div class="tl"><svg class="i"><use href="#${icon}"/></svg>${title}${body.est?'<span class="tr">estimate</span>':""}</div>${body.html}</div>`;
  let dep;
  if(T.result){ const s=T.result.selected, nofit=T.result.status==="nofit";
    const val=nofit?`<span class="bad">Does not fit</span>`:s.assumedT!=null?`${svgEsc(T.ac.label)} ${s.assumedT}<small>°C</small>`:T.ac.family==="airbus"?"TOGA":"Full thrust";
    dep=side("dep","i-takeoff",`Takeoff · ${svgEsc(T.end.e.id)}`,{est:true,html:`<div class="val num">${val}</div><div class="sub num">${svgEsc(s.flap)} · V1 ${toKt(s.v1)} · VR ${toKt(s.vr)} · V2 ${toKt(s.v2)}</div>`}); }
  else dep=side("dep","i-takeoff","Takeoff",{html:`<div class="sub">${why(T,"takeoff")}</div>`});
  let arr="";
  if(L?.result){ const r=L.result, a=r.selected;
    arr=side("arr","i-landing",`Landing · ${svgEsc(L.end.e.id)}`,{est:true,html:`<div class="val num">${r.status==="nofit"?`<span class="bad">Does not fit</span>`:`<span class="${r.status==="tight"?"warn":""}">VAPP ${toKt(r.vapp)}</span><small>kt</small>`}</div>
    <div class="sub num">${svgEsc(r.flap)} · VREF ${toKt(r.vref)} · autobrake ${svgEsc(a.name)}${r.status==="tight"?' · <span class="warn">dispatch ✗</span>':""}</div>`}); }
  else if(L&&!L.ga) arr=side("arr","i-landing","Landing",{html:`<div class="sub">${why(L,"landing")}</div>`});
  return `<div class="tile span-7${arr?" split":""}" data-tile="takeoff" data-open="takeoff" tabindex="0" role="button" aria-label="Open Takeoff & landing">${dep}${arr}</div>`;
}
function takeoffSetupRow(X){
  const T=X.takeoff; if(!T||!T.result) return "";
  const s=T.result.selected;
  return `<div class="sbox to-setup" data-to-setup data-open="takeoff" data-to-side="dep" title="Open takeoff data"><div class="k">Takeoff data · estimate</div>
    <div class="v">${toKt(s.v1)} / ${toKt(s.vr)} / ${toKt(s.v2)}</div><div class="s">${T.result.status==="nofit"?"does not fit":s.assumedT!=null?`${svgEsc(T.ac.label)} ${s.assumedT}°`:"TOGA"} · flaps ${svgEsc(s.flap)}</div></div>`;
}

function landingSetupRow(X){
  const L=X.landing; if(!L||!L.result) return "";
  const r=L.result;
  return `<div class="sbox to-setup" data-ld-setup data-open="takeoff" data-to-side="arr" title="Open landing data"><div class="k">Landing data · estimate</div>
    <div class="v">${toKt(r.vref)} / ${toKt(r.vapp)}</div><div class="s">VREF / VAPP · flaps ${svgEsc(r.flap)} · ${r.status==="nofit"?"does not fit":"autobrake "+svgEsc(r.selected.name)}${r.status==="tight"?' · <span class="warn">dispatch ✗ (runway below the dispatch requirement)</span>':""}</div></div>`;
}

/* ---------------------------------------------------------------- interaction */
function refreshTakeoff(X){
  X.takeoff=takeoffResult(X); X.landing=landingResult(X);
  if(typeof document==="undefined") return;
  // re-rendering replaces the controls: put focus back on the same control (typing Tab moves on as expected)
  const a=document.activeElement, d=a?.dataset||{};
  const key=d.to?`[data-to="${d.to}"]`:d.ld?`[data-ld="${d.ld}"]`:d.toOpt?`[data-to-opt="${d.toOpt}"][data-v="${d.v}"]`
    :d.ldOpt?`[data-ld-opt="${d.ldOpt}"][data-v="${d.v}"]`:d.toSide?`[data-to-side="${d.toSide}"]`:null;
  const panel=document.querySelector('.tabpanel[data-tab="takeoff"]'); if(panel) panel.innerHTML=takeoffView(X);
  if(key&&panel) panel.querySelector(key)?.focus({preventScroll:true});
  const tile=document.querySelector('[data-tile="takeoff"]'); if(tile) tile.outerHTML=takeoffTile(X)||"<span data-tile=\"takeoff\" hidden></span>";
  const row=document.querySelector("[data-to-setup]"); if(row) row.outerHTML=takeoffSetupRow(X)||"<span data-to-setup hidden></span>";
  const lrow=document.querySelector("[data-ld-setup]"); if(lrow) lrow.outerHTML=landingSetupRow(X)||"<span data-ld-setup hidden></span>";
}
if(typeof document!=="undefined"){
  const X=()=>window.LAST_X;
  document.addEventListener("click",e=>{
    if(!X()) return;
    const sd=e.target.closest?.("[data-to-side]");
    if(sd){ e.preventDefault(); try{ localStorage.setItem(TO_SIDE_KEY,sd.dataset.toSide); }catch(_){} refreshTakeoff(X()); return; }
    const lb=e.target.closest?.("[data-ld-opt]"), lr=e.target.closest?.("[data-ld-reset]");
    if(lb||lr){ e.preventDefault(); const ov=X().toState.ldg;
      if(lr){ const k=lr.dataset.ldReset; delete ov[k]; if(ov.byRwy) for(const id in ov.byRwy) delete ov.byRwy[id][k]; }
      else if(lb.dataset.ldOpt==="wet") ov.wet=lb.dataset.v==="true";
      else setLdOpt(lb.dataset.ldOpt,lb.dataset.v);
      refreshTakeoff(X()); return; }
    const b=e.target.closest?.("[data-to-opt]"), r=e.target.closest?.("[data-to-reset]"); if(!(b||r)) return;
    e.preventDefault();
    if(r){ const k=r.dataset.toReset, ov=X().toState.overrides; delete ov[k]; if(ov.byRwy) for(const id in ov.byRwy) delete ov.byRwy[id][k]; }
    else if(b.dataset.toOpt==="wet") X().toState.overrides.wet=b.dataset.v==="true";
    else setToOpt(b.dataset.toOpt, b.dataset.toOpt==="packs"?b.dataset.v==="true":b.dataset.v);
    refreshTakeoff(X());
  });
  document.addEventListener("change",e=>{
    const t=e.target; if(!X()) return;
    if(t?.dataset?.ld){
      const all=X().toState.ldg, k=t.dataset.ld, id=X().landing?.end?.e?.id;
      const ov=LD_RWY_KEYS.has(k)&&id?((all.byRwy||(all.byRwy={}))[id]||(all.byRwy[id]={})):all;
      const v=parseFloat(String(t.value).replace(",",".")); if(t.value.trim()===""||!toValid(k,v)) delete ov[k]; else ov[k]=v;
      refreshTakeoff(X()); return; }
    if(!t?.dataset?.to) return;
    const all=X().toState.overrides, k=t.dataset.to, id=X().takeoff?.end?.e?.id;
    const ov=TO_RWY_KEYS.has(k)&&id?((all.byRwy||(all.byRwy={}))[id]||(all.byRwy[id]={})):all;
    if(k==="lineup") ov.lineup=t.value;
    else { const v=parseFloat(String(t.value).replace(",",".")); if(t.value.trim()===""||!toValid(k,v)) delete ov[k]; else ov[k]=v; }
    refreshTakeoff(X());
  });
}
