"use strict";
/* =====================================================================
   Takeoff view: V1/VR/V2, reduced-thrust temperature, flaps and required vs available runway for the departure
   runway, from the plan (aircraft, takeoff weight, runway chosen in FS2024 setup, METAR). The model is toperf.js;
   per-type data comes from data/to_ref.json + data/to_tune.json through XD. Airliners (OpenAP) only.
   Also the Overview tile and the FS2024-setup row that summarise it. For simulation only.
   ===================================================================== */
const TO_OPTS_KEY="xperf.to.opts", TO_OPT_DEFAULTS={flap:"optimum",thrust:"reduced",packs:true,antiIce:"off"};
let TO_DATA=null;   // {ref, tune} | {error}
// loaded once the page's scripts have all run (XD's fetch helper lives in index.html's inline script)
if(typeof document!=="undefined") document.addEventListener("DOMContentLoaded",()=>{
  Promise.all([XD.toRef(),XD.toTune()]).then(([r,t])=>{ TO_DATA={ref:r.types,tune:t.types}; },e=>{ TO_DATA={error:e.message||String(e)}; })
    .then(()=>{ if(window.LAST_X&&typeof render==="function"){ const y=scrollY; render(window.LAST_X); scrollTo(0,y); } });   // tile + setup row too
});

function toOpts(){ let o={}; try{ o=JSON.parse(localStorage.getItem(TO_OPTS_KEY)||"{}")||{}; }catch(_){}
  return {...TO_OPT_DEFAULTS,...o}; }
function setToOpt(k,v){ const o=toOpts(); o[k]=v; try{ localStorage.setItem(TO_OPTS_KEY,JSON.stringify(o)); }catch(_){} }

// Plan → model input. end = a runway end from airportBrief() ({r,e,o}); overrides = values typed in the view.
function toInputs(X,end,overrides,opts){
  const B=X.briefs.dep, met=B.met||null, ov=overrides||{}, src={};
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

/* ---------------------------------------------------------------- rendering */
const toFt=(ft,cls="")=>`<span class="num ${cls}">${fmtK(ft)} ft</span> <span class="note num">· ${fmtK(ft*0.3048)} m</span>`;
const toKt=v=>Math.round(v);
function toTempTxt(T,sel){ return sel.assumedT!=null?`${T.ac.label} ${sel.assumedT}°`:T.ac.family==="airbus"?"TOGA":"Full thrust"; }
function toStatusHtml(T){ const r=T.result, s=r.selected;
  if(r.status==="nofit") return s.requiredFt>s.availableFt?`<span class="bad">Does not fit — short by ${fmtK(r.shortfallFt)} ft</span>`
    :`<span class="bad">Does not fit — one-engine-out climb ${(s.grad2*100).toFixed(1)} % below ${(s.grad2Min*100).toFixed(1)} %</span>`;
  if(r.status==="toga") return `<span class="warn">${T.input.thrust==="full"?"Full thrust selected":"No reduced thrust possible"} — ${T.ac.family==="airbus"?"TOGA":"full rated thrust"}</span>`;
  return `<span class="good">Reduced thrust: ${toTempTxt(T,s)} · thrust −${Math.round(s.thrustRed*100)} %</span>`; }

function toRunwayBar(T){
  const s=T.result.selected, len=T.input.lengthFt, used=Math.max(0,len-s.availableFt);
  const span=Math.max(len,used+s.goFt,used+s.stopFt,used+s.requiredFt)*1.03, X=ft=>(ft/span*1000).toFixed(1);
  const end=used+s.requiredFt, over=s.requiredFt>s.availableFt;
  return `<svg class="to-rwy" viewBox="0 0 1000 78" preserveAspectRatio="none" role="img" aria-label="Runway ${T.end.e.id}: ${fmtK(s.requiredFt)} ft required of ${fmtK(s.availableFt)} ft available">
    <defs><pattern id="toHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="var(--line-strong)"/></pattern></defs>
    <rect x="0" y="24" width="${X(len)}" height="18" rx="3" fill="var(--active)"/>
    ${used?`<rect x="0" y="24" width="${X(used)}" height="18" fill="url(#toHatch)"/>`:""}
    <rect x="${X(used)}" y="48" width="${X(s.goFt)}" height="5" rx="2" fill="var(--accent)"/>
    <rect x="${X(used)}" y="57" width="${X(s.stopFt)}" height="5" rx="2" fill="var(--text-3)"/>
    <line x1="${X(used+s.v1Ft)}" x2="${X(used+s.v1Ft)}" y1="20" y2="46" stroke="var(--text-2)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="${X(end)}" x2="${X(end)}" y1="14" y2="66" stroke="${over?"var(--bad)":"var(--text)"}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>
  <div class="to-rwy-labels num"><span style="left:${X(used+s.v1Ft)/10}%">V1</span><span style="left:${Math.min(X(end)/10,88)}%">${fmtK(s.requiredFt)} ft required</span></div>`;
}

function takeoffView(X){
  const T=X.takeoff, head=sub=>`<div class="to-head"><h2 class="viewtitle">Takeoff${sub?` <span class="note">${sub}</span>`:""}</h2>${T&&T.result?`<span class="badge warn">XPerf estimate · for simulation only</span>${T.result.tuned?`<span class="badge ok">tuned to ${T.ac.family==="airbus"?"Airbus":"Boeing"} airport-planning charts</span>`:""}`:""}</div>`;
  if(!T||T.ga) return head()+`<div class="card"><p class="note">Takeoff data is for airliners. For this aircraft see the runway check in <a href="#airports" data-open="airports">Airports &amp; weather</a>.</p></div>`;
  if(T.pending) return head()+`<div class="card"><p class="note">Loading takeoff data…</p></div>`;
  if(T.error) return head()+`<div class="card"><p class="note">${svgEsc(T.error)}</p></div>`;
  if(T.norunway) return head()+`<div class="card"><p class="note">No runway data for the departure airport — takeoff data needs a runway.</p></div>`;
  const {ac,input,src,result:r,end,B}=T, s=r.selected, ov=X.toState.overrides, code=String(X.m.code).toUpperCase();
  const field=(k,label,val,unit,{step="any"}={})=>`<label class="to-field"><span class="k">${label}</span>
      <span class="to-inrow"><input class="num" data-to="${k}" inputmode="decimal" value="${val}" aria-label="${label}"><span class="u">${unit}</span></span>
      <span class="to-src">${src[k]==="edited"?`edited · <button class="to-reset" data-to-reset="${k}">reset</button>`:svgEsc(src[k]||"")}</span></label>`;
  const seg=(key,label,items,cur)=>`<div class="to-opt"><span class="k">${label}</span><div class="seg" role="group" aria-label="${label}">${items.map(([v,t])=>
      `<button type="button" data-to-opt="${key}" data-v="${v}" aria-pressed="${String(cur)===String(v)}">${t}</button>`).join("")}</div></div>`;
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
        <label class="to-field"><span class="k">Intersection — runway behind you</span><span class="to-inrow"><input class="num" data-to="intersectionFt" inputmode="decimal" value="${ov.intersectionFt||0}" aria-label="Runway behind you at the intersection"><span class="u">ft</span></span></label>
        <label class="to-field"><span class="k">Line-up</span><select data-to="lineup" aria-label="Line-up allowance">${[["none","None"],["90","90° turn"],["180","180° turn"]].map(([v,t])=>`<option value="${v}" ${input.lineup===v?"selected":""}>${t}</option>`).join("")}</select></label>
      </div>
    </div>`;
  const big=(k,v,u,cls="",sub="")=>`<div class="to-stat"><div class="k">${k}</div><div class="v num ${cls}">${v}${u?`<small>${u}</small>`:""}</div>${sub?`<div class="s">${sub}</div>`:""}</div>`;
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
      <div class="to-legend"><span><i style="background:var(--accent)"></i>Accelerate-go, one engine out, to ${input.wet?"15":"35"} ft · ${fmtK(s.goFt)} ft</span>
        <span><i style="background:var(--text-3)"></i>Accelerate-stop · ${fmtK(s.stopFt)} ft</span>
        ${s.availableFt<input.lengthFt?`<span><i class="hatch"></i>Behind you · ${fmtK(input.lengthFt-s.availableFt)} ft</span>`:""}
        <span>Margin <b class="num ${s.availableFt-s.requiredFt<0?"bad":""}">${fmtK(s.availableFt-s.requiredFt)} ft</b></span></div>
    </div>
    <div class="to-box"><h3>Limits checked</h3><div class="to-limits">
      ${s.limits.map(l=>`<span class="${l.ok?"good":"bad"}">●</span><span>${{field:"Field length (balanced V1)",grad2:"One-engine-out climb, 2nd segment",thrust:"Thrust reduction at most 25 %"}[l.id]}</span><span class="note num">${l.text}</span>`).join("")}
      <span class="warn">●</span><span>Obstacles, VMCG / VMBE / tyre speed</span><span class="note">not modelled</span></div></div>
    <div class="to-box"><h3>Every flap setting</h3><div class="tblwrap"><table><tr><th>Flaps</th><th>${svgEsc(ac.label)}</th><th>V1</th><th>VR</th><th>V2</th><th>Required ft</th><th>2nd seg</th></tr>
      ${r.byFlap.map(f=>`<tr class="${f===s?"pick":""}"><td>${svgEsc(f.flap)}${f.flap===r.optimum?" ★":""}</td><td>${f.assumedT!=null?f.assumedT+" °C":f.status==="nofit"?"—":"TOGA"}</td>
        <td>${toKt(f.v1)}</td><td>${toKt(f.vr)}</td><td>${toKt(f.v2)}</td><td class="${f.requiredFt>f.availableFt?"bad":""}">${fmtK(f.requiredFt)}</td><td>${(f.grad2*100).toFixed(1)} %</td></tr>`).join("")}</table></div></div>
    <div class="callout warn"><svg class="i"><use href="#i-alert"/></svg><div><b>Estimated with a generic jet model from OpenAP data${r.tuned?", field length tuned to the manufacturer's airport-planning charts":""}.</b>
      Speeds typically within ±5–8 kt and distances ±10–15 %${r.tuned?" (±5 % against the charts)":""}; not the manufacturer's takeoff tables. Trim is not computed. If your aircraft's EFB calculates takeoff data, use that.
      The runway check in Airports &amp; weather uses a simpler method, so its distances differ.</div></div>`;
  return head(`${B.a.icao} ${svgEsc(end.e.id)} · ${code}`)+`<div class="to-grid"><div class="to-col">${inputs}</div><div class="to-col">${results}</div></div>`;
}

/* ---------------------------------------------------------------- summaries (Overview tile, FS2024 setup row) */
function takeoffTile(X){
  const T=X.takeoff; if(!T||!T.result) return "";
  const s=T.result.selected, nofit=T.result.status==="nofit";
  const val=nofit?`<span class="bad">Does not fit</span>`:s.assumedT!=null?`${svgEsc(T.ac.label)} ${s.assumedT}<small>°C</small>`:T.ac.family==="airbus"?"TOGA":"Full thrust";
  return `<div class="tile span-7" data-tile="takeoff" data-open="takeoff" tabindex="0" role="button" aria-label="Open Takeoff">
    <div class="tl"><svg class="i"><use href="#i-takeoff"/></svg>Takeoff · ${svgEsc(T.end.e.id)}<span class="tr">estimate</span></div>
    <div class="val num">${val}</div><div class="sub num">${svgEsc(s.flap)} · V1 ${toKt(s.v1)} · VR ${toKt(s.vr)} · V2 ${toKt(s.v2)}</div></div>`;
}
function takeoffSetupRow(X){
  const T=X.takeoff; if(!T||!T.result) return "";
  const s=T.result.selected;
  return `<div class="sbox to-setup" data-to-setup data-open="takeoff" title="Open Takeoff"><div class="k">Takeoff data · estimate</div>
    <div class="v">${toKt(s.v1)} / ${toKt(s.vr)} / ${toKt(s.v2)}</div><div class="s">${T.result.status==="nofit"?"does not fit":s.assumedT!=null?`${svgEsc(T.ac.label)} ${s.assumedT}°`:"TOGA"} · flaps ${svgEsc(s.flap)}</div></div>`;
}

/* ---------------------------------------------------------------- interaction */
function refreshTakeoff(X){
  X.takeoff=takeoffResult(X);
  if(typeof document==="undefined") return;
  const panel=document.querySelector('.tabpanel[data-tab="takeoff"]'); if(panel) panel.innerHTML=takeoffView(X);
  const tile=document.querySelector('[data-tile="takeoff"]'); if(tile) tile.outerHTML=takeoffTile(X)||"<span data-tile=\"takeoff\" hidden></span>";
  const row=document.querySelector("[data-to-setup]"); if(row) row.outerHTML=takeoffSetupRow(X)||"<span data-to-setup hidden></span>";
}
if(typeof document!=="undefined"){
  const X=()=>window.LAST_X;
  document.addEventListener("click",e=>{
    const b=e.target.closest?.("[data-to-opt]"), r=e.target.closest?.("[data-to-reset]"); if(!X()||!(b||r)) return;
    e.preventDefault();
    if(r){ delete X().toState.overrides[r.dataset.toReset]; }
    else if(b.dataset.toOpt==="wet") X().toState.overrides.wet=b.dataset.v==="true";
    else setToOpt(b.dataset.toOpt, b.dataset.toOpt==="packs"?b.dataset.v==="true":b.dataset.v);
    refreshTakeoff(X());
  });
  document.addEventListener("change",e=>{
    const t=e.target; if(!t?.dataset?.to||!X()) return;
    const ov=X().toState.overrides, k=t.dataset.to;
    if(k==="lineup") ov.lineup=t.value;
    else { const v=parseFloat(String(t.value).replace(",",".")); if(t.value.trim()===""||!Number.isFinite(v)) delete ov[k]; else ov[k]=v; }
    refreshTakeoff(X());
  });
}
