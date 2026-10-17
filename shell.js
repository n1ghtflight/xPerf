/* =====================================================================
   XPerf shell — app chrome around the planner (nightflight-ui house style).
   Views: one .tabpanel[data-tab] per view (render() emits them, Settings is static); the sidebar,
   the phone tab bar / More sheet and keyboard chords all go through Shell.showView().
   Theme: follows the OS by default ("system"); "dark"/"light" force it via <html data-theme>.
   ===================================================================== */
const Shell=(()=>{
  const root=document.documentElement, THEMES=["system","dark","light"];
  const VIEWS=[["overview","Overview"],["route","Route & nav log"],["airports","Airports & weather"],["profile","Profile"],
               ["fuel","Fuel & levels"],["setup","FS2024 setup"],["settings","Settings"]];
  const PHONE_TABS=["overview","route","airports","profile","more"];
  const CHORDS={o:"overview",r:"route",a:"airports",p:"profile",f:"fuel",s:"setup"};
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
    $$("[data-view]").forEach(b=>{ const on=b.dataset.view===id; if(on) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current"); });
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
    const v=e.target.closest&&e.target.closest("[data-view]");
    if(v){ e.preventDefault(); showView(v.dataset.view); if(!matchMedia("(min-width:1024px)").matches) $("#app")?.classList.remove("expanded"); return; }
    if(e.target.closest("#sbBtn")) toggleSidebar();
    else if(e.target.closest("#navBack")) go(-1);
    else if(e.target.closest("#navFwd")) go(1);
    else if(e.target.closest("#themeBtn")) setTheme(THEMES[(THEMES.indexOf(theme)+1)%THEMES.length]);
    else if(!e.target.closest(".moresheet")) toggleMore(false);
  });
  document.addEventListener("change",e=>{ if(e.target.id==="themeSel") setTheme(e.target.value); });

  // G then a letter jumps to a view; "," opens Settings; "[" toggles the sidebar. Never while typing.
  let chord=null, chordT=0;
  document.addEventListener("keydown",e=>{
    if(e.ctrlKey||e.metaKey||e.altKey||e.defaultPrevented) return;
    if(e.target.closest&&e.target.closest("input,textarea,select,[contenteditable]")) return;
    const k=e.key.toLowerCase();
    if(chord==="g"){ chord=null; if(CHORDS[k]){ e.preventDefault(); showView(CHORDS[k]); } return; }
    if(k==="g"){ chord="g"; clearTimeout(chordT); chordT=setTimeout(()=>chord=null,1200); return; }
    if(k===","){ e.preventDefault(); showView("settings"); }
    else if(k==="["){ e.preventDefault(); toggleSidebar(); }
  });

  return { VIEWS, PHONE_TABS, setTheme, theme:()=>theme, showView, current:()=>current, setCrumb, setData, toggleSidebar, store };
})();
