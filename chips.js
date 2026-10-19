"use strict";
/* =====================================================================
   Setup chips. Before the first plan the full setup form sits in the work surface; after a successful
   plan it moves into the "All settings" drawer and a summary line of chips appears above the results.
   Every chip only writes into the existing form fields (#ac #dep #arr #nav #rules #opt #fl #etd …) and
   calls replan(), which runs the unchanged calculate(). The form stays the single source of truth.
   ===================================================================== */
const Chips=(()=>{
  const $=id=>document.getElementById(id), body=document.body;
  const OPTS={  // option chips: select id → [value, short label, key]
    nav:[["direct","Direct","D"],["vor","VOR","V"],["vorndb","VOR + NDB","N"],["awy","Airways","W"],["pub","Published","P"],["import","Your route","R"]],
    rules:[["ifr","IFR","I"],["vfr","VFR","V"],["any","Any level","A"]],
    opt:[["fuel","Min fuel","F"],["time","Min time","T"]],
  };
  const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const short=(id,v)=>(OPTS[id].find(o=>o[0]===v)||[v,v])[1];
  const levelTxt=()=>$("fl").value==="auto"?"Auto level":lvl(+$("fl").value);
  const etdTxt=()=>{ const v=$("etd").value; return v?`ETD ${v.slice(11,16)}Z`:"ETD now"; };
  let menuChip=null, acHome=null;
  const EMPTY_RESULTS=$("results")?.innerHTML||"";      // the start screen, restored by New flight

  /* ---------- re-planning: latest choice wins, runs never overlap */
  let running=null, again=false;
  function replan(){
    if(running){ again=true; return running; }
    // on phones the drawer is full-screen: close it so the result (or the error) is visible
    if(!$("allSettings").hidden&&matchMedia("(max-width:767px)").matches) closeDrawer();
    body.classList.add("replanning"); $("results")?.setAttribute("aria-busy","true");
    running=(async()=>{ try{ do{ again=false; await calculate(); }while(again); }
      finally{ running=null; body.classList.remove("replanning"); $("results")?.removeAttribute("aria-busy");
        // chips show the form as it is now (also after a failed plan), so a bad value stays visible
        if(body.classList.contains("planned")&&window.LAST_X) $("chipbar").innerHTML=render(window.LAST_X); } })();
    return running;
  }

  /* ---------- summary line */
  function render(X){
    // read the form, not the last result: after a failed plan the chips must show what will be planned next
    const code=s=>String(s||"").trim().toUpperCase().split(/\s/)[0];
    const acOpt=$("ac").selectedOptions[0], ac=(acOpt&&(acOpt.textContent.match(/\(([^)]+)\)\s*$/)||[])[1])||String(X.m.code).toUpperCase();
    const dep=code($("dep").value), arr=code($("arr").value), altV=code($("alt").value);
    const routeBad=!resolveApt("dep")||!resolveApt("arr")||(altV&&!resolveApt("alt")), alt=altV?` · alt ${altV}`:"";
    const chip=(k,txt,tip,bad)=>`<button type="button" class="pchip${bad?" bad":""}" data-chip="${k}" aria-haspopup="true"${tip?` data-tip="${esc(tip)}"`:""}>${txt}<svg class="i caret"><use href="#i-caret"/></svg></button>`;
    return chip("ac",`<b>${esc(ac)}</b>`,X.m.label)+
      chip("route",`<b>${esc(dep)}</b> → <b>${esc(arr)}</b>${esc(alt)}`,routeBad?"Unknown airport code":"Departure and arrival",routeBad)+
      chip("nav",esc(sbActive()&&$("nav").value==="import"?"SimBrief":short("nav",$("nav").value)),"Navigation")+
      chip("rules",esc(short("rules",$("rules").value)),"Level rules")+
      chip("opt",esc(short("opt",$("opt").value)),"Optimise for")+
      chip("fl",esc(levelTxt()),"Cruise level")+
      chip("etd",esc(etdTxt()),"Departure time (UTC)")+
      `<button type="button" class="pchip ghost" data-chip="all" aria-haspopup="dialog"><svg class="i"><use href="#i-settings"/></svg>All settings</button>`+
      `<button type="button" class="pchip ghost" data-chip="new" data-tip="Clear this plan and start again (keeps the aircraft)"><svg class="i"><use href="#i-plus"/></svg>New flight</button>`;
  }
  function afterRender(X){
    if(!body.classList.contains("planned")){
      body.classList.add("planned");
      $("drawerBody").appendChild(document.querySelector(".formcol"));   // same nodes, same ids
      $("errSlot").appendChild($("err"));
    }
    const bar=$("chipbar"); bar.hidden=false; bar.innerHTML=render(X);
    Shell.touchCopy($("results"));
    syncForm();
  }

  /* ---------- chip menus */
  function closeMenu(){
    const m=$("chipMenu"); if(m.hidden) return;
    if(acHome&&acHome.wrap){ acHome.parent.insertBefore(acHome.wrap,acHome.next); acHome=null; }
    m.hidden=true; m.innerHTML=""; menuChip=null;
    document.querySelectorAll('.pchip[aria-expanded="true"]').forEach(b=>b.setAttribute("aria-expanded","false"));
  }
  function openMenu(btn){
    const k=btn.dataset.chip, m=$("chipMenu");
    if(menuChip===k){ closeMenu(); return; }
    closeMenu();
    if(k==="all"){ openDrawer(); return; }
    if(k==="new"){ newFlight(); return; }
    menuChip=k; btn.setAttribute("aria-expanded","true");
    if(OPTS[k]||k==="fl"){
      const sel=$(k), rows=OPTS[k]||[...sel.options].map(o=>[o.value,o.textContent,""]);
      m.innerHTML=rows.map(([v,l,key])=>`<button type="button" data-value="${esc(v)}" class="${sel.value===v?"on":""}"><span>${esc(l)}</span>${key?`<kbd>${key}</kbd>`:""}</button>`).join("");
      m.className="chipmenu list";
    } else if(k==="route"){
      m.className="chipmenu form";
      m.innerHTML=`<div class="routeedit"><label>From<input id="chipDep" class="icao" list="aptList" autocomplete="off" value="${esc($("dep").value)}"></label>
        <button type="button" class="icon-btn" id="chipSwap" data-tip="Swap"><svg class="i"><use href="#i-swap"/></svg></button>
        <label>To<input id="chipArr" class="icao" list="aptList" autocomplete="off" value="${esc($("arr").value)}"></label></div>
        <button type="button" class="planbtn" id="chipRouteGo">Re-plan <kbd>↵</kbd></button>`;
    } else if(k==="etd"){
      m.className="chipmenu form";
      m.innerHTML=`<label>Departure (UTC)<input id="chipEtd" type="datetime-local" value="${esc($("etd").value)}"></label>
        <button type="button" class="planbtn" id="chipEtdGo">Re-plan <kbd>↵</kbd></button>`;
    } else if(k==="ac"){
      m.className="chipmenu form ac";
      const wrap=document.querySelector(".acpick");
      if(wrap){ acHome={wrap,parent:wrap.parentNode,next:wrap.nextSibling}; m.appendChild(wrap); }
    }
    m.hidden=false;
    const r=btn.getBoundingClientRect(), w=Math.min(m.offsetWidth||260,innerWidth-16);
    m.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left))+"px"; m.style.top=(r.bottom+6)+"px";
    m.querySelector("input")?.focus();
  }
  function pick(v){
    const k=menuChip, sel=$(k); if(!sel) return;
    if(k==="nav"&&v==="import"&&!$("route").value.trim()){ closeMenu(); openImport(); return; }   // nothing to fly yet: ask for the route
    sel.value=v; sel.dispatchEvent(new Event("change",{bubbles:true}));
    closeMenu(); replan();
  }
  function applyRoute(){
    const d=$("chipDep").value.trim(), a=$("chipArr").value.trim();
    $("dep").value=d; $("arr").value=a; closeMenu(); syncForm(); replan();
  }
  function applyEtd(){ $("etd").value=$("chipEtd").value; closeMenu(); replan(); }

  /* ---------- New flight: back to the start screen; keeps the aircraft and the planning preferences */
  function newFlight(){
    closeMenu(); closeDrawer();
    for(const id of ["dep","arr","alt","etd","route"]) $(id).value="";
    $("fl").value="auto"; ROUTE_SB=null; hint(HINT0); $("err").textContent="";
    if(body.classList.contains("planned")){                 // undo afterRender: the form leaves the drawer
      body.classList.remove("planned");
      document.querySelector(".work").prepend(document.querySelector(".formcol"));
      $("go").after($("err"));
      $("chipbar").hidden=true; $("chipbar").innerHTML="";
    }
    window.LAST_X=null; $("results").innerHTML=EMPTY_RESULTS;
    Shell.setCrumb("New flight"); Shell.showView("overview"); syncForm();
    $("dep").focus();
  }

  /* ---------- All settings drawer */
  function openDrawer(){ closeMenu(); $("allSettings").hidden=false; body.classList.add("drawer-open"); $("allSettings").querySelector("input,select,button")?.focus(); }
  function closeDrawer(){ $("allSettings").hidden=true; body.classList.remove("drawer-open"); }

  /* ---------- setup form helpers (segmented buttons, resolved airport names) */
  function buildSegs(){
    document.querySelectorAll(".seg[data-for]").forEach(seg=>{
      const id=seg.dataset.for;
      seg.innerHTML=OPTS[id].map(([v,l])=>`<button type="button" data-seg="${v}" aria-pressed="false">${esc(l)}</button>`).join("");
    });
  }
  function aptLine(id){
    const el=$(id+"Res"); if(!el) return;
    const v=$(id).value.trim().toUpperCase().split(/\s/)[0], a=typeof DB!=="undefined"&&v?DB.aptIndex[v]:null;
    el.textContent=a?`${a.name} · ${fmtK(a.alt)} ft`:v.length>=3?"not found":"";
    el.classList.toggle("bad",!a&&v.length>=3);
  }
  function syncForm(){
    document.querySelectorAll(".seg[data-for]").forEach(seg=>{ const v=$(seg.dataset.for).value;
      seg.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.seg===v))); });
    aptLine("dep"); aptLine("arr");
    $("routeImport").hidden=$("nav").value!=="import";
    const o=$("oxy"); if(o) o.setAttribute("aria-checked",String(o.checked));
  }

  /* ---------- your own route: pasted text or a SimBrief OFP (parsing in routeimport.js, planning in nav.js) */
  const HINT0="Airports at the ends set From and To. FAA airways (US) are followed; elsewhere fix to fix.";
  const sbActive=()=>!!(ROUTE_SB&&ROUTE_SB.text===$("route").value.trim());
  const hint=(t,bad)=>{ const h=$("routeHint"); h.textContent=t; h.classList.toggle("err",!!bad); };
  function setNav(v){ const s=$("nav"); if(s.value!==v){ s.value=v; s.dispatchEvent(new Event("change",{bubbles:true})); } syncForm(); }
  function openImport(){
    setNav("import");
    if(body.classList.contains("planned")) openDrawer();
    const r=$("route"); r.scrollIntoView({block:"center"}); r.focus();
  }
  // airports at either end of the typed route become From / To (the planner's own rule, routeimport.js)
  function routeEnds(){
    if(sbActive()) return;
    const r=resolveRoute($("route").value,{dep:null,arr:null,findApt:id=>DB.aptIndex[id]||null,
      findFix:id=>NAV.loaded?routeIdIndex().get(id)||[]:[],airway:()=>null});
    if(r.from) $("dep").value=r.from.icao;
    if(r.to) $("arr").value=r.to.icao;
    syncForm();
  }
  function applySimbrief(sb){
    ROUTE_SB={...sb,text:`${sb.dep} ${sb.route} ${sb.arr}`.replace(/\s+/g," ").trim()};
    $("route").value=ROUTE_SB.text; $("dep").value=sb.dep; $("arr").value=sb.arr;
    if(sb.altn&&DB.aptIndex[sb.altn]) $("alt").value=sb.altn;
    if(sb.etdMs) $("etd").value=new Date(sb.etdMs).toISOString().slice(0,16);
    setNav("import");
    const code=o=>((o.textContent.match(/\(([^)]+)\)\s*$/)||[])[1]||"").toUpperCase();
    const opt=sb.acType?[...$("ac").options].find(o=>o.value&&code(o)===sb.acType.toUpperCase()):null;
    if(opt&&$("ac").value!==opt.value) AcPicker.set(opt.value);
    hint(`SimBrief ${sb.dep} → ${sb.arr}${sb.airac?` · AIRAC ${sb.airac}`:""} · ${sb.points.length} fixes${sb.initialAlt?` · filed ${lvl(sb.initialAlt)}`:""}`+
      `${sb.acType&&!opt?` · ${sb.acType} isn't in XPerf, so the current aircraft is kept`:""}. Editing the route switches to the typed route.`);
    replan();
  }
  async function loadSimbrief(getText,what){
    hint(`Loading ${what}…`);
    try{ applySimbrief(parseSimbriefXML(await getText())); }
    catch(e){ hint(/abort/i.test(e.message)?"SimBrief didn't answer — try again.":e.message,true); }
  }
  function fetchSimbrief(){
    const s=$("sbSrc").value.trim();
    if(!s){ hint("Enter your SimBrief username or pilot ID (Account settings on simbrief.com), or paste an OFP link.",true); $("sbSrc").focus(); return; }
    try{ localStorage.setItem("xperf.simbrief",s); }catch(_){}
    loadSimbrief(()=>XD.simbrief(s),/^https?:/i.test(s)?"the SimBrief flight plan":`${s}'s latest SimBrief flight plan`);
  }
  try{ const s=localStorage.getItem("xperf.simbrief"); if(s) $("sbSrc").value=s; }catch(_){}

  /* ---------- events */
  document.addEventListener("click",e=>{
    const t=e.target;
    const chip=t.closest(".pchip"); if(chip){ openMenu(chip); return; }
    const opt=t.closest(".chipmenu.list [data-value]"); if(opt){ pick(opt.dataset.value); return; }
    if(t.closest("#chipRouteGo")){ applyRoute(); return; }
    if(t.closest("#chipEtdGo")){ applyEtd(); return; }
    if(t.closest("#chipSwap")){ const d=$("chipDep"), a=$("chipArr"); [d.value,a.value]=[a.value,d.value]; return; }
    if(t.closest("#swapBtn")){ [$("dep").value,$("arr").value]=[$("arr").value,$("dep").value]; syncForm(); return; }
    const seg=t.closest(".seg [data-seg]"); if(seg){ const sel=$(seg.closest(".seg").dataset.for); sel.value=seg.dataset.seg;
      sel.dispatchEvent(new Event("change",{bubbles:true})); syncForm(); return; }
    if(t.closest("#drawerClose")){ closeDrawer(); return; }
    if(t.closest("#sbFetch")){ fetchSimbrief(); return; }
    if(!t.closest("#chipMenu")) closeMenu();
  });
  document.addEventListener("input",e=>{ const id=e.target.id;
    if(id==="route"&&ROUTE_SB&&!sbActive()){ ROUTE_SB=null; hint(HINT0); }
    if(id==="dep"||id==="arr") aptLine(id);
    if(id==="chipDep"||id==="chipArr") aptSearch(e); });
  document.addEventListener("change",e=>{
    if(["nav","rules","opt","fl","oxy"].includes(e.target.id)) syncForm();
    if(e.target.id==="route") routeEnds();
    if(e.target.id==="sbFile"&&e.target.files[0]){ const f=e.target.files[0]; e.target.value=""; loadSimbrief(()=>f.text(),f.name); }
    // aircraft picked from the chip's search box: re-plan with it straight away
    // (capture phase: AcPicker dispatches a non-bubbling change event on #ac)
    // replan on the next task, after the app's own #ac handler (onAircraft) has started loading the new model
    if(e.target.id==="ac"&&menuChip==="ac"){ closeMenu(); setTimeout(replan,0); }
  },true);
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault(); if(e.target.id==="route") routeEnds();
      if(body.classList.contains("planned")) replan(); else if(!$("go").disabled) $("go").click(); return; }
    if(e.key==="Escape"){ if(Palette.isOpen()) return; if(!$("chipMenu").hidden){ closeMenu(); e.preventDefault(); } else if(!$("allSettings").hidden){ closeDrawer(); e.preventDefault(); } return; }
    if(e.key==="Enter"&&(e.target.id==="chipDep"||e.target.id==="chipArr")){ e.preventDefault(); applyRoute(); return; }
    if(e.key==="Enter"&&e.target.id==="chipEtd"){ e.preventDefault(); applyEtd(); return; }
    if(e.key==="Enter"&&e.target.id==="sbSrc"){ e.preventDefault(); fetchSimbrief(); return; }
    // single-letter keys inside an open option menu (never while typing in a field elsewhere)
    const typing=e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]")&&!e.target.closest("#chipMenu");
    if(menuChip&&OPTS[menuChip]&&!typing&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      const hit=OPTS[menuChip].find(o=>o[2].toLowerCase()===e.key.toLowerCase());
      if(hit){ e.preventDefault(); e.stopPropagation(); pick(hit[0]); }
    }
  },true);

  return { render, afterRender, replan, syncForm, buildSegs, openDrawer, closeDrawer, closeMenu, openImport, routeEnds, newFlight };
})();
