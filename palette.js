"use strict";
/* =====================================================================
   Command-palette logic with no DOM, so it can be unit-tested (tests/palette.test.mjs).
   parseTypedPlan("KPAO KTRK C172") → {kind:"plan", dep, arr, ac}. Airports resolve by ICAO/ident/IATA/alias
   first, then by ICAO prefix or name; a query only counts as a plan when its first word is an airport.
   ===================================================================== */
var parseTypedPlan=function(text,{aptIndex,airports,aircraft}){
  const SEP=new Set(["TO","-","→","->","–","—"]);
  const tokens=String(text||"").replace(/(→|->|–|—)/g," ").trim().split(/\s+/).filter(t=>t&&!SEP.has(t.toUpperCase()));
  if(tokens.length<2||tokens.length>3) return {kind:"none"};
  const MAX=8;
  function find(token){
    const T=token.toUpperCase();
    if(aptIndex[T]) return {kind:"one",apt:aptIndex[T]};
    if(T.length<3) return {kind:"none",list:[]};
    const list=airports.filter(a=>a.icao.toUpperCase().startsWith(T)||(a.iata&&a.iata.toUpperCase()===T)||String(a.name||"").toUpperCase().includes(T));
    return list.length===1?{kind:"one",apt:list[0]}:{kind:list.length?"many":"none",list};
  }
  const d=find(tokens[0]);
  if(d.kind==="none"||(d.kind==="many"&&d.list.length>MAX)) return {kind:"none"};
  if(d.kind==="many") return {kind:"ambiguous",field:"dep",token:tokens[0],candidates:d.list.slice(0,MAX)};
  const a=find(tokens[1]);
  if(a.kind==="none") return {kind:"unknown",field:"arr",token:tokens[1]};
  if(a.kind==="many") return {kind:"ambiguous",field:"arr",token:tokens[1],candidates:a.list.slice(0,MAX)};
  let ac=null;
  if(tokens[2]){
    const hit=aircraft.find(x=>String(x.code).toUpperCase()===tokens[2].toUpperCase());
    if(!hit) return {kind:"unknown",field:"ac",token:tokens[2]};
    ac=hit.value;
  }
  return {kind:"plan",dep:d.apt,arr:a.apt,ac};
};

// Typed-plan rows come first, unless the query is the start of a command's name: "new flight" must find
// New flight even though NEW is also an airport code.
var paletteRows=function(typed,commands,query){
  const q=String(query||"").trim().toLowerCase();
  return q&&commands.some(c=>String(c.label).toLowerCase().startsWith(q))?[...commands,...typed]:[...typed,...commands];
};

var filterCommands=function(commands,query){
  const q=String(query||"").trim().toLowerCase();
  return q?commands.filter(c=>String(c.label).toLowerCase().includes(q)):commands.slice();
};
