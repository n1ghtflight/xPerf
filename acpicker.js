"use strict";
/* =====================================================================
   Searchable aircraft picker. A combobox over the (hidden) #ac <select>,
   so the rest of the app keeps reading $("ac").value and its change event.
   Type any part of a name, maker, ICAO code or class ("172", "king air",
   "pa28", "737 max", "turboprop").
   ===================================================================== */
const AcPicker=(()=>{
  const norm=s=>String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"");
  let items=[], shown=[], active=-1, sel, input, list, wrap, lastGood="";

  function index(){
    items=[];
    for(const g of sel.querySelectorAll("optgroup")) for(const o of g.querySelectorAll("option")){
      if(o.value==="other") continue;
      const group=g.label.replace(/ — .*/,""), code=(o.textContent.match(/\(([^)]+)\)\s*$/)||[])[1]||"";
      const name=o.textContent.replace(/\s*\([^)]+\)\s*$/,"");
      items.push({value:o.value,text:o.textContent,name,code,group,src:g.label.includes("OpenAP")?"OpenAP":"XPerf",
        hay:norm(`${o.textContent} ${group} ${code}`),hayWords:`${o.textContent} ${group}`.toLowerCase()});
    }
  }
  function score(it,q,tokens){
    if(!tokens.length) return 1;
    for(const t of tokens) if(!it.hay.includes(t)) return 0;
    const c=norm(it.code); let s=1;
    if(c===q) s+=100; else if(c.startsWith(q)) s+=40;
    if(norm(it.name).startsWith(tokens[0])) s+=20;
    if(it.hayWords.split(/[^a-z0-9]+/).some(w=>w.startsWith(tokens[0]))) s+=10;
    return s;
  }
  function render(qRaw){
    const q=norm(qRaw), tokens=qRaw.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
    shown=items.map(it=>({it,s:score(it,q,tokens)})).filter(x=>x.s>0);
    if(tokens.length) shown.sort((a,b)=>b.s-a.s||a.it.text.localeCompare(b.it.text));
    let html="", lastGroup=null;
    const grouped=!tokens.length;
    shown.forEach((x,i)=>{ const it=x.it;
      if(grouped&&it.group!==lastGroup){ html+=`<div class="acgrp">${it.group}</div>`; lastGroup=it.group; }
      html+=`<div class="acopt${i===active?" on":""}${it.value===sel.value?" cur":""}" role="option" data-i="${i}" id="acopt${i}">
        <span class="acname">${hl(it.name,tokens)}</span><span class="accode">${hl(it.code,tokens)}</span>${grouped?"":`<span class="acgroup">${it.group}</span>`}</div>`; });
    if(!shown.length) html=`<div class="acnone">No aircraft match “${esc(qRaw)}”. Try a maker, model number or 2–4 letter ICAO type code.</div>`;
    list.innerHTML=html;
  }
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  function hl(text,tokens){
    let out=esc(text); if(!tokens.length) return out;
    // highlight the plain-text runs that contain a token (punctuation-insensitive tokens are matched loosely)
    for(const t of tokens){ if(t.length<2) continue;
      const re=new RegExp(`(${t.split("").map(ch=>ch.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("[^a-z0-9]?")})`,"ig");
      out=out.replace(re,"<mark>$1</mark>"); }
    return out;
  }
  function open(){ if(!list.hidden) return; list.hidden=false; input.setAttribute("aria-expanded","true"); active=-1; render(input.value===lastGood?"":input.value);
    const cur=list.querySelector(".cur"); if(cur) cur.scrollIntoView({block:"center"}); }
  function close(restore=true){ list.hidden=true; input.setAttribute("aria-expanded","false"); active=-1; if(restore) input.value=lastGood; }
  function move(d){ if(list.hidden) open(); if(!shown.length) return;
    active=(active+d+shown.length)%shown.length; list.querySelectorAll(".acopt").forEach(el=>el.classList.toggle("on",+el.dataset.i===active));
    const el=document.getElementById("acopt"+active); if(el){ el.scrollIntoView({block:"nearest"}); input.setAttribute("aria-activedescendant",el.id); } }
  function choose(i){
    const x=shown[i]; if(!x) return;
    set(x.it.value);
    close(false); input.blur();
  }
  function set(value){
    sel.value=value; sync(); sel.dispatchEvent(new Event("change"));
    try{ localStorage.setItem("xperf.ac",value); }catch(_){}
  }
  function sync(){ const it=items.find(i=>i.value===sel.value); lastGood=it?`${it.name} (${it.code})`:""; input.value=lastGood; }

  function init(){
    sel=document.getElementById("ac"); if(!sel||wrap) return;
    sel.hidden=true;
    wrap=document.createElement("div"); wrap.className="acpick";
    wrap.innerHTML=`<input id="acSearch" type="text" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="acList" aria-label="Aircraft"
      placeholder="Search: name, maker or ICAO (C172, king air, 737)"><span class="acicon">⌕</span><div id="acList" class="aclist" role="listbox" hidden></div>`;
    sel.insertAdjacentElement("afterend",wrap);
    input=wrap.querySelector("input"); list=wrap.querySelector(".aclist");
    index();
    try{ const last=localStorage.getItem("xperf.ac"); if(last&&[...sel.options].some(o=>o.value===last)) sel.value=last; }catch(_){}
    sync();
    input.addEventListener("focus",()=>{ input.select(); open(); });
    input.addEventListener("click",()=>open());
    input.addEventListener("input",()=>{ if(list.hidden){ list.hidden=false; input.setAttribute("aria-expanded","true"); } active=-1; render(input.value); if(shown.length&&input.value.trim()) move(1); });
    input.addEventListener("keydown",e=>{
      if(e.key==="ArrowDown"){ e.preventDefault(); move(1); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); move(-1); }
      else if(e.key==="Enter"){ if(!list.hidden&&active>=0){ e.preventDefault(); choose(active); } }
      else if(e.key==="Escape"){ close(); input.blur(); }
      else if(e.key==="Tab"&&!list.hidden&&active>=0) choose(active);
    });
    list.addEventListener("mousedown",e=>{ const el=e.target.closest(".acopt"); if(el){ e.preventDefault(); choose(+el.dataset.i); } });
    input.addEventListener("blur",()=>setTimeout(()=>{ if(document.activeElement!==input) close(); },120));
  }
  return {init,sync,index};
})();
