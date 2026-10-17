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
    nav:[["direct","Direct","D"],["vor","VOR","V"],["vorndb","VOR + NDB","N"],["awy","Airways","W"],["pub","Published","P"]],
    rules:[["ifr","IFR","I"],["vfr","VFR","V"],["any","Any level","A"]],
    opt:[["fuel","Min fuel","F"],["time","Min time","T"]],
  };
  const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const short=(id,v)=>(OPTS[id].find(o=>o[0]===v)||[v,v])[1];
  const levelTxt=()=>$("fl").value==="auto"?"Auto level":lvl(+$("fl").value);
  const etdTxt=()=>{ const v=$("etd").value; return v?`ETD ${v.slice(11,16)}Z`:"ETD now"; };
  let menuChip=null, acHome=null;

  /* ---------- re-planning: latest choice wins, runs never overlap */
  let running=null, again=false;
  function replan(){
    if(running){ again=true; return running; }
    body.classList.add("replanning"); $("results")?.setAttribute("aria-busy","true");
    running=(async()=>{ try{ do{ again=false; await calculate(); }while(again); }
      finally{ running=null; body.classList.remove("replanning"); $("results")?.removeAttribute("aria-busy"); } })();
    return running;
  }

  /* ---------- summary line */
  function render(X){
    const ac=String(X.m.code).toUpperCase(), alt=X.altApt?` · alt ${X.altApt.icao}`:"";
    const chip=(k,txt,tip)=>`<button type="button" class="pchip" data-chip="${k}" aria-haspopup="true"${tip?` data-tip="${esc(tip)}"`:""}>${txt}<svg class="i caret"><use href="#i-caret"/></svg></button>`;
    return chip("ac",`<b>${esc(ac)}</b>`,X.m.label)+
      chip("route",`<b>${esc(X.dep.icao)}</b> → <b>${esc(X.arr.icao)}</b>${esc(alt)}`,"Departure and arrival")+
      chip("nav",esc(short("nav",$("nav").value)),"Navigation")+
      chip("rules",esc(short("rules",$("rules").value)),"Level rules")+
      chip("opt",esc(short("opt",$("opt").value)),"Optimise for")+
      chip("fl",esc(levelTxt()),"Cruise level")+
      chip("etd",esc(etdTxt()),"Departure time (UTC)")+
      `<button type="button" class="pchip ghost" data-chip="all" aria-haspopup="dialog"><svg class="i"><use href="#i-settings"/></svg>All settings</button>`;
  }
  function afterRender(X){
    if(!body.classList.contains("planned")){
      body.classList.add("planned");
      $("drawerBody").appendChild(document.querySelector(".formcol"));   // same nodes, same ids
      $("errSlot").appendChild($("err"));
    }
    const bar=$("chipbar"); bar.hidden=false; bar.innerHTML=render(X);
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
    sel.value=v; sel.dispatchEvent(new Event("change",{bubbles:true}));
    closeMenu(); replan();
  }
  function applyRoute(){
    const d=$("chipDep").value.trim(), a=$("chipArr").value.trim();
    $("dep").value=d; $("arr").value=a; closeMenu(); syncForm(); replan();
  }
  function applyEtd(){ $("etd").value=$("chipEtd").value; closeMenu(); replan(); }

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
    const o=$("oxy"); if(o) o.setAttribute("aria-checked",String(o.checked));
  }

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
    if(!t.closest("#chipMenu")) closeMenu();
  });
  document.addEventListener("input",e=>{ const id=e.target.id;
    if(id==="dep"||id==="arr") aptLine(id);
    if(id==="chipDep"||id==="chipArr") aptSearch(e); });
  document.addEventListener("change",e=>{
    if(["nav","rules","opt","fl","oxy"].includes(e.target.id)) syncForm();
    // aircraft picked from the chip's search box: re-plan with it straight away
    if(e.target.id==="ac"&&menuChip==="ac"){ closeMenu(); replan(); }
  });
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault();
      if(body.classList.contains("planned")) replan(); else if(!$("go").disabled) $("go").click(); return; }
    if(e.key==="Escape"){ if(!$("chipMenu").hidden){ closeMenu(); e.preventDefault(); } else if(!$("allSettings").hidden){ closeDrawer(); e.preventDefault(); } return; }
    if(e.key==="Enter"&&(e.target.id==="chipDep"||e.target.id==="chipArr")){ e.preventDefault(); applyRoute(); return; }
    if(e.key==="Enter"&&e.target.id==="chipEtd"){ e.preventDefault(); applyEtd(); return; }
    // single-letter keys inside an open option menu
    if(menuChip&&OPTS[menuChip]&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
      const hit=OPTS[menuChip].find(o=>o[2].toLowerCase()===e.key.toLowerCase());
      if(hit){ e.preventDefault(); e.stopPropagation(); pick(hit[0]); }
    }
  },true);

  return { render, afterRender, replan, syncForm, buildSegs, openDrawer, closeDrawer, closeMenu };
})();
