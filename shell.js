/* =====================================================================
   XPerf shell — app chrome around the planner (nightflight-ui house style).
   Views: one .tabpanel[data-tab] per view (render() emits them, Settings is static); the sidebar,
   the phone tab bar / More sheet and keyboard chords all go through Shell.showView().
   Theme: follows the OS by default ("system"); "dark"/"light" force it via <html data-theme>.
   ===================================================================== */
const Shell=(()=>{
  const root=document.documentElement, THEMES=["system","dark","light"];
  // view links and tab buttons; #surface also carries data-view (the current view, for CSS) but is not a control
  const NAV_CTL="a[data-view],button[data-view]";
  const VIEWS=[["overview","Overview"],["route","Route & nav log"],["airports","Airports & weather"],["takeoff","Takeoff & landing"],["profile","Profile"],
               ["fuel","Fuel & levels"],["setup","FS2024 setup"],["settings","Settings"]];
  const PHONE_TABS=["overview","route","airports","profile","more"];
  const CHORDS={o:"overview",r:"route",a:"airports",t:"takeoff",p:"profile",f:"fuel",s:"setup"};
  const store={get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } },
               set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} }};
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  let theme="system", current=null, hist=[], hi=-1;

  /* ---------- theme */
  function setTheme(t){
    theme=THEMES.includes(t)?t:"system";
    if(theme==="system") root.removeAttribute("data-theme"); else root.dataset.theme=theme;
    store.set("xperf.theme",theme);
    const b=$("#themeBtn"); if(b) b.dataset.tip="Theme: "+theme;
    const sel=$("#themeSel"); if(sel) sel.value=theme;
    document.dispatchEvent(new CustomEvent("xperf:theme",{detail:theme}));
  }
  setTheme(store.get("xperf.theme")||"system");

  /* ---------- views */
  function showView(id,{record=true}={}){
    if(id==="more"){ toggleMore(); return; }
    if(!VIEWS.some(v=>v[0]===id)) return;
    toggleMore(false);
    current=id;
    $$(".tabpanel").forEach(p=>p.hidden=p.dataset.tab!==id);
    const surface=$("#surface"); if(surface) surface.dataset.view=id;
    $$(NAV_CTL).forEach(b=>{ const on=b.dataset.view===id; if(on) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current"); });
    store.set("xperf.tab",id);
    if(record&&hist[hi]!==id){ hist=hist.slice(0,hi+1); hist.push(id); hi=hist.length-1; }
    if(surface) surface.scrollTop=0;
    document.dispatchEvent(new CustomEvent("xperf:view",{detail:id}));
  }
  function go(step){ const j=hi+step; if(j<0||j>=hist.length) return; hi=j; showView(hist[hi],{record:false}); }
  function toggleMore(force){ const m=$("#moreSheet"); if(!m) return; m.hidden=force===undefined?!m.hidden:!force; }
  function toggleSidebar(){
    const app=$("#app"), wide=matchMedia("(min-width:1024px)").matches;
    if(wide) app.classList.toggle("collapsed"); else app.classList.toggle("expanded");
  }

  /* ---------- title bar */
  function setCrumb(text){ const c=$("#crumb"); if(c) c.textContent=text; }
  function setData(text){ const c=$("#dataChip"); if(!c) return; c.hidden=!text; c.textContent=text||""; }

  /* ---------- events */
  document.addEventListener("click",e=>{
    const v=e.target.closest&&e.target.closest(NAV_CTL);
    if(v){ e.preventDefault(); showView(v.dataset.view); if(!matchMedia("(min-width:1024px)").matches) $("#app")?.classList.remove("expanded"); return; }
    if(e.target.closest("#sbBtn")) toggleSidebar();
    else if(e.target.closest("#navBack")) go(-1);
    else if(e.target.closest("#navFwd")) go(1);
    else if(e.target.closest("#themeBtn")) setTheme(THEMES[(THEMES.indexOf(theme)+1)%THEMES.length]);
    else if(!e.target.closest(".moresheet")) toggleMore(false);
  });
  document.addEventListener("change",e=>{ if(e.target.id==="themeSel") setTheme(e.target.value);
    if(e.target.id==="bpTgl"){ document.body.classList.toggle("no-blueprint",!e.target.checked); store.set("xperf.blueprint",e.target.checked?"1":"0"); } });
  // offline use and "Install app": the static site's service worker (never on the local dev server)
  const sw=document.querySelector('meta[name="xperf-sw"]')?.content;
  if(sw&&"serviceWorker" in navigator) navigator.serviceWorker.register(sw).catch(e=>console.warn("service worker",e));
  if(store.get("xperf.blueprint")==="0"){ document.body.classList.add("no-blueprint"); const t=document.getElementById("bpTgl"); if(t) t.checked=false; }

  // G then a letter jumps to a view; "," opens Settings; "[" toggles the sidebar. Never while typing.
  let chord=null, chordT=0;
  document.addEventListener("keydown",e=>{
    if(e.ctrlKey||e.metaKey||e.altKey||e.defaultPrevented) return;
    if(e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]")) return;
    const k=e.key.toLowerCase();
    if(chord==="g"){ chord=null; if(CHORDS[k]){ e.preventDefault(); showView(CHORDS[k]); } return; }
    if(k==="g"){ chord="g"; clearTimeout(chordT); chordT=setTimeout(()=>chord=null,1200); return; }
    if(k===","){ e.preventDefault(); showView("settings"); }
    else if(k==="e"&&window.LAST_X){ e.preventDefault(); document.querySelector("[data-pln]")?.click(); }
    else if(k==="["){ e.preventDefault(); toggleSidebar(); }
  });

  /* ---------- touch: hover-only details work by tap, and the copy says "tap" */
  const coarse=()=>matchMedia("(pointer: coarse)").matches;
  function touchCopy(rootEl){
    if(!rootEl||!coarse()) return;
    const w=document.createTreeWalker(rootEl,NodeFilter.SHOW_TEXT,{acceptNode:n=>/\bhover\b/i.test(n.nodeValue)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT});
    const nodes=[]; while(w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach(n=>n.nodeValue=n.nodeValue.replace(/\bhover\b/gi,m=>m[0]==="H"?"Tap":"tap"));
  }
  const sticky=document.createElement("div"); sticky.className="tip sticky"; sticky.hidden=true; sticky.setAttribute("role","status");
  document.body.appendChild(sticky);
  let lastPointer="mouse";
  document.addEventListener("pointerdown",e=>{ lastPointer=e.pointerType; },true);
  document.addEventListener("click",e=>{
    if(lastPointer==="mouse") return;
    // SVG chart parts carry their details in a <title> child (shown on hover by the browser, never on touch)
    let el=e.target.closest&&e.target.closest("svg *"), title=null;
    while(el&&el.tagName.toLowerCase()!=="svg"&&!title){ title=[...el.children].find(c=>c.tagName.toLowerCase()==="title"); if(!title) el=el.parentElement; }
    if(!title){ sticky.hidden=true; return; }
    sticky.textContent=title.textContent; sticky.hidden=false;
    const x=e.clientX, y=e.clientY;
    sticky.style.left=Math.max(8,Math.min(innerWidth-sticky.offsetWidth-8,x-sticky.offsetWidth/2))+"px";
    sticky.style.top=Math.max(8,y-sticky.offsetHeight-12)+"px";
  });

  return { VIEWS, PHONE_TABS, setTheme, theme:()=>theme, showView, current:()=>current, setCrumb, setData, toggleSidebar, touchCopy, store };
})();

/* =====================================================================
   Command palette (Ctrl/Cmd+K). Typed plans first ("KPAO KTRK C172"), then actions on the current plan,
   then navigation and app commands — each with its shortcut shown as keycaps.
   Parsing/filtering live in palette.js (unit-tested); this is the UI.
   ===================================================================== */
const Palette=(()=>{
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const reEsc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  let root=null, items=[], selI=0;

  function aircraftList(){
    return [...($("ac")?.options||[])].filter(o=>o.value&&o.value!=="other")
      .map(o=>({value:o.value,code:(o.textContent.match(/\(([^)]+)\)\s*$/)||[])[1]||"",name:o.textContent.replace(/\s*\([^)]+\)\s*$/,"")}));
  }
  const replan=()=>Chips.replan();
  const setSel=(id,v)=>{ const s=$(id); s.value=v; s.dispatchEvent(new Event("change",{bubbles:true})); };
  const routeText=X=>X.route.plan?.routeString||X.route.points.map(p=>p.label).join(" ");

  function staticCommands(){
    const X=window.LAST_X, cmds=[];
    if(X){
      const g="This plan";
      cmds.push({group:g,label:"Export .PLN for FS2024",keys:["E"],run:()=>document.querySelector("[data-pln]")?.click()},
        {group:g,label:"Copy route",keys:[],run:()=>navigator.clipboard?.writeText(routeText(X))},
        {group:g,label:"Swap departure and arrival",keys:[],run:()=>{ [$("dep").value,$("arr").value]=[$("arr").value,$("dep").value]; Chips.syncForm(); replan(); }},
        ...[["ifr","IFR"],["vfr","VFR"],["any","Any level"]].map(([v,l])=>({group:g,label:`Rules: ${l}`,keys:[],run:()=>{ setSel("rules",v); replan(); }})),
        {group:g,label:"Navigation…",keys:[],run:()=>document.querySelector('[data-chip="nav"]')?.click()},
        {group:g,label:"Change aircraft…",keys:[],run:()=>document.querySelector('[data-chip="ac"]')?.click()},
        {group:g,label:"All settings",keys:[],run:()=>Chips.openDrawer()});
    }
    cmds.push({group:"Flight",label:"Random flight",keys:[],run:()=>RandomFlight.open()});
    for(const [id,k] of [["overview","O"],["route","R"],["airports","A"],["takeoff","T"],["profile","P"],["fuel","F"],["setup","S"]])
      cmds.push({group:"Navigate",label:"Go to "+Shell.VIEWS.find(v=>v[0]===id)[1],keys:["G",k],run:()=>Shell.showView(id)});
    cmds.push({group:"Navigate",label:"Open Settings",keys:[","],run:()=>Shell.showView("settings")},
      {group:"App",label:"New flight",keys:[],run:()=>Chips.newFlight()},
      {group:"App",label:"Your route: paste or load from SimBrief…",keys:[],run:()=>Chips.openImport()},
      {group:"App",label:"Switch theme",keys:[],run:()=>{ const t=["system","dark","light"]; Shell.setTheme(t[(t.indexOf(Shell.theme())+1)%3]); }},
      {group:"App",label:"Toggle sidebar",keys:["["],run:()=>Shell.toggleSidebar()});
    return cmds;
  }

  function typedRows(q){
    if(typeof DB==="undefined"||!DB.airports) return [];
    const list=aircraftList(), r=parseTypedPlan(q,{aptIndex:DB.aptIndex,airports:DB.airports,aircraft:list}), G="Plan a flight";
    // a pasted route ("KPAO OAK V195 ILA V200 RANGO KTRK"): airports at both ends, something in between
    const t=tokenizeRoute(q), end=s=>s.length===4&&DB.aptIndex[s];
    if(r.kind!=="plan"&&t.length>=3&&end(t[0])&&end(t[t.length-1]))
      return [{group:G,label:`Fly route ${t[0]} → ${t[t.length-1]} via ${t.slice(1,-1).join(" ")}`,keys:["↵"],run:()=>runRoute(q)}];
    if(r.kind==="plan"){
      const ac=r.ac?(list.find(a=>a.value===r.ac)||{}).code:String(window.MODEL?.code||"").toUpperCase();
      return [{group:G,label:`Plan ${r.dep.icao} → ${r.arr.icao}${ac?" in "+ac:""}`,keys:["↵"],run:()=>runPlan(r)}];
    }
    if(r.kind==="ambiguous") return r.candidates.map(a=>({group:G,label:`${r.field==="dep"?"From":"To"} = ${a.icao} ${a.name}, ${a.country}`,keys:[],keep:true,
      run:()=>{ const inp=$("pInput"); inp.value=inp.value.replace(new RegExp(reEsc(r.token),"i"),a.icao); render(); }}));
    if(r.kind==="unknown") return [{group:G,label:r.field==="ac"?`No aircraft type “${r.token}”`:`No airport matches “${r.token}”`,keys:[],disabled:true,run:()=>{}}];
    return [];
  }
  async function runPlan(r){
    if(r.ac&&$("ac").value!==r.ac) AcPicker.set(r.ac);
    $("dep").value=r.dep.icao; $("arr").value=r.arr.icao; Chips.syncForm();
    await replan();
  }

  async function runRoute(q){
    $("route").value=q.trim(); setSel("nav","import"); Chips.routeEnds();
    await replan();
  }

  function render(){
    const q=$("pInput").value;
    items=paletteRows(typedRows(q),filterCommands(staticCommands(),q),q);
    const firstOk=items.findIndex(i=>!i.disabled); selI=firstOk<0?0:firstOk;
    let html="", last="";
    items.forEach((c,i)=>{ if(c.group!==last){ html+=`<div class="p-group">${esc(c.group)}</div>`; last=c.group; }
      html+=`<div class="p-item${c.disabled?" off":""}" role="option" data-i="${i}" aria-selected="${i===selI}">${esc(c.label)}<span class="keys">${c.keys.map(k=>`<kbd>${esc(k)}</kbd>`).join("")}</span></div>`; });
    $("pList").innerHTML=html||`<div class="p-empty">No matching commands</div>`;
  }
  function select(i){ selI=i; $("pList").querySelectorAll(".p-item").forEach(el=>el.setAttribute("aria-selected",String(+el.dataset.i===selI)));
    $("pList").querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"}); }
  function run(){ const c=items[selI]; if(!c||c.disabled) return; if(!c.keep) close(); c.run(); }
  function step(d){ const n=items.length; if(!n) return; let j=selI; for(let k=0;k<n;k++){ j=(j+d+n)%n; if(!items[j].disabled) break; } select(j); }

  function build(){
    root=document.createElement("div"); root.id="paletteRoot"; root.hidden=true;
    root.innerHTML=`<div class="palette-bd"></div><div class="palette" id="palette" role="dialog" aria-label="Command palette">
      <input id="pInput" placeholder="Type a command, or plan a flight: KPAO KTRK C172" autocomplete="off" spellcheck="false" role="combobox" aria-controls="pList" aria-expanded="true">
      <div class="p-list" id="pList" role="listbox"></div></div>`;
    document.body.appendChild(root);
    root.querySelector(".palette-bd").addEventListener("click",close);
    const inp=$("pInput");
    inp.addEventListener("input",render);
    inp.addEventListener("keydown",e=>{
      if(e.key==="ArrowDown"){ e.preventDefault(); step(1); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); step(-1); }
      else if(e.key==="Enter"&&!e.ctrlKey&&!e.metaKey){ e.preventDefault(); run(); }
      else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); close(); }
    });
    $("pList").addEventListener("mousemove",e=>{ const it=e.target.closest(".p-item"); if(it&&+it.dataset.i!==selI&&!items[+it.dataset.i].disabled) select(+it.dataset.i); });
    // stopPropagation: a command may open a chip menu, which the same click would otherwise close again
    $("pList").addEventListener("click",e=>{ const it=e.target.closest(".p-item"); if(it){ e.stopPropagation(); select(+it.dataset.i); run(); } });
  }
  function open(){ if(typeof Chips!=="undefined") Chips.closeMenu(); if(!root) build(); root.hidden=false; $("pInput").value=""; render(); $("pInput").focus(); }
  function close(){ if(root) root.hidden=true; }
  const isOpen=()=>!!root&&!root.hidden;
  document.addEventListener("keydown",e=>{
    if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==="k"){ e.preventDefault(); e.stopPropagation(); isOpen()?close():open(); }
  },true);
  return {open,close,isOpen};
})();

/* Tooltips that teach shortcuts: [data-tip] (+ data-kbd "G O") after a short hover */
(()=>{
  const tip=document.createElement("div"); tip.className="tip"; tip.hidden=true; document.body.appendChild(tip);
  const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  let t=0;
  document.addEventListener("pointerover",e=>{
    const el=e.target.closest&&e.target.closest("[data-tip]"); clearTimeout(t);
    if(!el||e.pointerType==="touch"){ tip.hidden=true; return; }
    t=setTimeout(()=>{
      tip.innerHTML=esc(el.dataset.tip)+(el.dataset.kbd||"").split(" ").filter(Boolean).map(k=>`<kbd>${esc(k)}</kbd>`).join("");
      tip.hidden=false; const r=el.getBoundingClientRect();
      tip.style.left=Math.max(8,Math.min(innerWidth-tip.offsetWidth-8,r.left+r.width/2-tip.offsetWidth/2))+"px";
      tip.style.top=(r.bottom+6)+"px";
    },450);
  });
  document.addEventListener("pointerdown",()=>{ clearTimeout(t); tip.hidden=true; });
})();
