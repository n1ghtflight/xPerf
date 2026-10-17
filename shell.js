/* =====================================================================
   XPerf shell — app chrome around the planner (nightflight-ui house style).
   Theme: follows the OS by default ("system"); "dark"/"light" force it via <html data-theme>.
   ===================================================================== */
const Shell=(()=>{
  const root=document.documentElement, THEMES=["system","dark","light"];
  const store={get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } },
               set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} }};
  let theme="system";

  function setTheme(t){
    theme=THEMES.includes(t)?t:"system";
    if(theme==="system") root.removeAttribute("data-theme"); else root.dataset.theme=theme;
    store.set("xperf.theme",theme);
    document.dispatchEvent(new CustomEvent("xperf:theme",{detail:theme}));
  }
  setTheme(store.get("xperf.theme")||"system");

  return { setTheme, theme:()=>theme, store };
})();
