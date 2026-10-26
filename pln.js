"use strict";
/* =====================================================================
   Microsoft Flight Simulator 2024 flight plan (.PLN) export in the EFB
   format (SDK: "EFB Flight Plan XML (PLN File) Properties"): the airports
   are DepartureID / DestinationID only, the runways, SID, STAR and approach
   go in DepartureDetails / ArrivalDetails / ApproachDetails (the sim inserts
   the procedure legs itself), and the ATCWaypoint list is the en-route part.
   Waypoints get their ICAO region from FAA data (US) or the nearby airports;
   fixes without a known region are written as user waypoints so the file
   always loads.
   ===================================================================== */
const xmlEsc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));
function llaPLN(lat,lon,altFt=0){
  const dms=(v,pos,neg)=>{ const h=v>=0?pos:neg, a=Math.abs(v), d=Math.floor(a), mf=(a-d)*60, m=Math.floor(mf), sec=(mf-m)*60;
    return `${h}${d}° ${m}' ${sec.toFixed(2)}"`; };
  const sign=altFt<0?"-":"+";
  return `${dms(lat,"N","S")},${dms(lon,"E","W")},${sign}${String(Math.abs(altFt).toFixed(2)).padStart(9,"0")}`;
}
function rwyParts(id){ const m=String(id||"").toUpperCase().match(/^0*(\d{1,2})([LRC]?)$/); if(!m) return null;
  return {num:String(+m[1]),des:{L:"LEFT",R:"RIGHT",C:"CENTER"}[m[2]]||"NONE"}; }
function approachTypePLN(name){ const n=String(name||"").toUpperCase();
  return /^ILS/.test(n)?"ILS":/^LOC/.test(n)?"LOCALIZER":/^LDA/.test(n)?"LDA":/^SDF/.test(n)?"SDF":/RNAV|GPS|RNP/.test(n)?"RNAV":/^VOR/.test(n)?"VOR":/^NDB/.test(n)?"NDB":/^GLS/.test(n)?"GLS":null; }
// o: {title, descr, rules:"VFR"|"IFR", cruise ft, dep, arr, enroute:[{id,type,region,lat,lon,alt,awy}],
//     depRwy/arrRwy:{num,des}, sid, star, appr:{type, rwy:{num,des}, suffix}} → the .PLN text
function plnXML(o){
  const I="        ", rwy=(r,ind)=>r?`${ind}<RunwayNumberFP>${xmlEsc(r.num)}</RunwayNumberFP>\n`+
    (r.des&&r.des!=="NONE"?`${ind}<RunwayDesignatorFP>${xmlEsc(r.des)}</RunwayDesignatorFP>\n`:""):"";
  const box=(tag,inner)=>inner?`${I}<${tag}>\n${inner}${I}</${tag}>\n`:"";
  const sub=I+"    ";
  const depD=box("DepartureDetails",rwy(o.depRwy,sub)+(o.sid?`${sub}<DepartureFP>${xmlEsc(o.sid)}</DepartureFP>\n`:""));
  const arrD=box("ArrivalDetails",rwy(o.arrRwy,sub)+(o.star?`${sub}<ArrivalFP>${xmlEsc(o.star)}</ArrivalFP>\n`:""));
  const apD=o.appr?box("ApproachDetails",`${sub}<ApproachTypeFP>${xmlEsc(o.appr.type)}</ApproachTypeFP>\n`+rwy(o.appr.rwy,sub)+
    (o.appr.suffix?`${sub}<SuffixFP>${xmlEsc(o.appr.suffix)}</SuffixFP>\n`:"")):"";
  const wp=w=>{ const user=!w.region;
    return `${I}<ATCWaypoint id="${xmlEsc(w.id)}">\n${sub}<ATCWaypointType>${user?"User":w.type}</ATCWaypointType>\n`+
      `${sub}<WorldPosition>${llaPLN(w.lat,w.lon,w.alt||0)}</WorldPosition>\n`+(w.awy?`${sub}<ATCAirway>${xmlEsc(w.awy)}</ATCAirway>\n`:"")+
      `${sub}<ICAO>\n`+(user?"":`${sub}    <ICAORegion>${xmlEsc(w.region)}</ICAORegion>\n`)+`${sub}    <ICAOIdent>${xmlEsc(w.id)}</ICAOIdent>\n${sub}</ICAO>\n`+
      `${I}</ATCWaypoint>\n`; };
  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
    <Descr>AceXML Document</Descr>
    <FlightPlan.FlightPlan>
${I}<Title>${xmlEsc(o.title)}</Title>
${I}<Descr>${xmlEsc(o.descr)}</Descr>
${I}<FPType>${o.rules}</FPType>
${I}<CruisingAlt>${Math.round(o.cruise)}</CruisingAlt>
${I}<DepartureID>${xmlEsc(o.dep)}</DepartureID>
${I}<DestinationID>${xmlEsc(o.arr)}</DestinationID>
${I}<AppVersion>
${I}    <AppVersionMajor>12</AppVersionMajor>
${I}</AppVersion>
${depD}${o.enroute.map(wp).join("")}${arrD}${apD}    </FlightPlan.FlightPlan>
</SimBase.Document>
`;
}
async function fetchRegions(pts){
  if(!HAS_SERVER||!pts.length) return pts.map(()=>null);
  try{ return (await XD.regions(pts))||pts.map(()=>null); }
  catch(e){ console.warn("regions",e); return pts.map(()=>null); }
}
async function buildPLN(X){
  const {dep,arr,route,sel,m}=X, D=X.briefs?.dep, A=X.briefs?.arr;
  const rules=$("rules").value==="vfr"?"VFR":"IFR";
  // the same choices the setup card shows
  const dEnd=D&&!D.missing?chosenDepRunway(D):null;
  const dp=D&&!D.missing?chosenProc(D,SID_KEY,["ODP","DP"],X,"sid",dEnd?.e.id):{sel:null};
  const star=A&&!A.missing?chosenProc(A,STAR_KEY,["STR"],X,"star"):{sel:null};
  const ap=A&&!A.missing?chosenApproach(A).sel:null;
  const aEnd=A&&!A.missing?(ap?.rwy?A.ends.find(x=>rwyKey(x.e.id)===ap.rwy)||A.best:A.best):null;
  const procIdent=(B,p,kind)=>{ if(!p) return null; const ms=[...(B?.info?.procs?.sids||[]),...(B?.info?.procs?.stars||[])];
    const mm=ms.find(x=>x.key===normProc(p.name)); if(mm) return kind==="sid"?mm.code.split(".")[0]:mm.code.split(".")[1];
    const w=p.name.replace(/\(.*?\)/g,"").trim().split(/\s+/), nums={ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINE:9};
    return w.length>1&&nums[w[w.length-1]]?w[0].slice(0,5)+nums[w[w.length-1]]:null; };
  const sid=dp.sel&&!dp.sel.obstacle?procIdent(D,dp.sel,"sid"):null, starId=star.sel?procIdent(A,star.sel,"star"):null;
  // a VFR plan carries an instrument approach only when the pilot picked one (the auto pick is for the briefing)
  let apPicked=false; try{ apPicked=!!localStorage.getItem(APPR_KEY+arr.icao); }catch(_){}
  const dR=rwyParts(dEnd?.e.id), aR=rwyParts(aEnd?.e.id), apType=ap&&ap.kind!=="visual"&&(rules==="IFR"||apPicked)?approachTypePLN(ap.name):null;
  // enroute waypoints with planned altitude and the airway flown to reach them
  const enr=[];
  route.points.forEach((P,i)=>{ if(P.kind==="apt") return;
    const meta=route.plan?.legs?.[i-1], x=route.legs[i-1].s0+route.legs[i-1].d, h=profileAtX(sel,X.total,x).h;
    const type=P.kind==="nav"?(NDB_TYPES.has(P.nav.type)?"NDB":"VOR"):"Intersection";
    enr.push({id:P.label,lat:P.lat,lon:P.lon,type,alt:Math.round(h),awy:meta&&meta.awy&&meta.awy!=="DCT"&&!meta.proc?meta.awy:null,proc:meta?.proc?meta.awy:null,region:P.region||null}); });
  const regions=await fetchRegions(enr);
  // outside FAA coverage the ICAO region is the two-letter prefix of the nearby airports (MR, EG, LF, CY, MM …)
  enr.forEach((o,i)=>{ if(regions[i]) return; if(o.region){ regions[i]=o.region; return; } let best=null;
    for(const a of DB.airports){ if(!/^[A-Z]{4}$/.test(a.icao)||/^[KP]/.test(a.icao)) continue;
      const dl=Math.abs(a.lat-o.lat); if(dl>2.5) continue; const d=gcDist(a,o)/NM; if(d<150&&(!best||d<best.d)) best={d,a}; }
    if(best) regions[i]=best.a.icao.slice(0,2); });
  const unknown=[];
  // procedure legs are left out: the sim builds them from DepartureFP / ArrivalFP
  const enroute=enr.map((o,i)=>({...o,region:regions[i]||null})).filter(o=>!(o.proc&&(o.proc===sid||o.proc===starId)));
  enroute.forEach(o=>{ if(!o.region) unknown.push(o.id); });
  const title=`${dep.icao} to ${arr.icao}`;
  const xml=plnXML({title, rules, cruise:sel.ft, dep:dep.icao, arr:arr.icao, enroute,
    descr:`${title} · ${route.plan?.routeString||enr.map(o=>o.id).join(" ")||"DCT"} · ${m.label} · ${lvl(sel.ft)} · planned with XPerf`,
    depRwy:dR, sid, arrRwy:aR, star:starId, appr:apType?{type:apType,rwy:rwyParts(ap.rwy)||aR}:null});
  return {xml,title,file:`${dep.icao}${arr.icao}.pln`,count:enroute.length,unknown,sid,starId,apType,dR,aR,rules};
}
async function downloadPLN(btn){
  if(!window.LAST_X) return;
  const label=btn?.innerHTML; if(btn){ btn.disabled=true; btn.innerHTML="Building .PLN…"; }
  try{
    const r=await buildPLN(LAST_X);
    const url=URL.createObjectURL(new Blob([r.xml],{type:"application/xml"}));
    const a=document.createElement("a"); a.href=url; a.download=r.file; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    const msg=`Saved <b>${r.file}</b>: ${r.rules}, ${r.count} en-route waypoint${r.count===1?"":"s"}${r.sid?`, SID ${r.sid}`:""}${r.starId?`, STAR ${r.starId}`:""}${r.apType?`, ${r.apType} approach`:""}.`+
      (r.unknown.length?` <span class="warn">${r.unknown.length} waypoint${r.unknown.length>1?"s":""} without a known ICAO region (${r.unknown.slice(0,6).join(", ")}${r.unknown.length>6?"…":""}) written as user waypoints.</span>`:"")+
      ` In FS2024: EFB → flight plan → Load .PLN, then pick this file.`;
    document.querySelectorAll(".plnNote").forEach(n=>n.innerHTML=msg);
  }catch(e){ console.error(e); alert("Could not build the .PLN file: "+e.message); }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=label; } }
}
document.addEventListener("click",e=>{ const b=e.target.closest&&e.target.closest("[data-pln]"); if(b){ e.preventDefault(); downloadPLN(b); } });
