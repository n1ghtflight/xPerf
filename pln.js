"use strict";
/* =====================================================================
   Microsoft Flight Simulator flight plan (.PLN) export — loads in the
   FS2024 (and FS2020) world map. Writes the planned route with airways,
   departure / arrival runways, SID / STAR (with transitions), approach,
   cruise altitude and flight rules. Waypoints get their ICAO region from
   FAA data (US); elsewhere VOR / NDB / fixes without a known region are
   written as user waypoints so the file always loads.
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
async function fetchRegions(pts){
  if(!HAS_SERVER||!pts.length) return pts.map(()=>null);
  try{ return (await XD.regions(pts))||pts.map(()=>null); }
  catch(e){ console.warn("regions",e); return pts.map(()=>null); }
}
async function buildPLN(X){
  const {dep,arr,route,sel,m}=X, D=X.briefs?.dep, A=X.briefs?.arr;
  const rules=$("rules").value==="vfr"?"VFR":"IFR";
  const mode=X.navMode, high=route.plan?.high||sel.ft>=18000;
  const routeType=mode==="direct"?"Direct":(mode==="vor"||mode==="vorndb")?"VOR":high?"HighAlt":"LowAlt";
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
  const dR=rwyParts(dEnd?.e.id), aR=rwyParts(aEnd?.e.id), apType=ap&&ap.kind!=="visual"?approachTypePLN(ap.name):null;
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
  const wp=(o)=>`        <ATCWaypoint id="${xmlEsc(o.id)}">
            <ATCWaypointType>${o.type}</ATCWaypointType>
            <WorldPosition>${llaPLN(o.lat,o.lon,o.alt||0)}</WorldPosition>
            <SpeedMaxFP>-1</SpeedMaxFP>${o.awy?`
            <ATCAirway>${xmlEsc(o.awy)}</ATCAirway>`:""}${o.dep?`
            <DepartureFP>${xmlEsc(o.dep)}</DepartureFP>`:""}${o.arr?`
            <ArrivalFP>${xmlEsc(o.arr)}</ArrivalFP>`:""}${o.appr?`
            <ApproachTypeFP>${o.appr}</ApproachTypeFP>`:""}${o.rwy?`
            <RunwayNumberFP>${o.rwy.num}</RunwayNumberFP>
            <RunwayDesignatorFP>${o.rwy.des}</RunwayDesignatorFP>`:""}${o.type!=="User"?`
            <ICAO>${o.region?`
                <ICAORegion>${o.region}</ICAORegion>`:""}
                <ICAOIdent>${xmlEsc(o.id)}</ICAOIdent>
            </ICAO>`:""}
        </ATCWaypoint>`;
  const unknown=[];
  const body=enr.map((o,i)=>{ const region=regions[i];
    const w={...o,region};
    if(!region&&o.type!=="Airport"){ w.type="User"; unknown.push(o.id); }
    if(o.proc&&o.proc===sid) w.dep=sid;                       // SID legs
    if(o.proc&&o.proc===starId) w.arr=starId;                 // STAR legs
    return wp(w); });
  const depWp=wp({id:dep.icao,lat:dep.lat,lon:dep.lon,alt:dep.alt,type:"Airport",dep:sid,rwy:dR});
  const arrWp=wp({id:arr.icao,lat:arr.lat,lon:arr.lon,alt:arr.alt,type:"Airport",arr:starId,appr:apType,rwy:aR});
  const title=`${dep.icao} to ${arr.icao}`;
  const xml=`<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
    <Descr>AceXML Document</Descr>
    <FlightPlan.FlightPlan>
        <Title>${xmlEsc(title)}</Title>
        <FPType>${rules}</FPType>
        <RouteType>${routeType}</RouteType>
        <CruisingAlt>${Math.round(sel.ft)}</CruisingAlt>
        <DepartureID>${xmlEsc(dep.icao)}</DepartureID>
        <DepartureLLA>${llaPLN(dep.lat,dep.lon,dep.alt)}</DepartureLLA>
        <DestinationID>${xmlEsc(arr.icao)}</DestinationID>
        <DestinationLLA>${llaPLN(arr.lat,arr.lon,arr.alt)}</DestinationLLA>
        <Descr>${xmlEsc(`${title} · ${route.plan?.routeString||enr.map(o=>o.id).join(" ")||"DCT"} · ${m.label} · ${lvl(sel.ft)} · planned with XPerf`)}</Descr>${dR?`
        <DeparturePosition>${dR.num}${dR.des!=="NONE"?dR.des[0]:""}</DeparturePosition>`:""}
        <DepartureName>${xmlEsc(dep.name)}</DepartureName>
        <DestinationName>${xmlEsc(arr.name)}</DestinationName>
        <AppVersion>
            <AppVersionMajor>12</AppVersionMajor>
            <AppVersionBuild>282174</AppVersionBuild>
        </AppVersion>
${[depWp,...body,arrWp].join("\n")}
    </FlightPlan.FlightPlan>
</SimBase.Document>
`;
  return {xml,title,file:`${dep.icao}${arr.icao}.pln`,count:enr.length,unknown,sid,starId,apType,dR,aR,rules,routeType};
}
async function downloadPLN(btn){
  if(!window.LAST_X) return;
  const label=btn?.innerHTML; if(btn){ btn.disabled=true; btn.innerHTML="Building .PLN…"; }
  try{
    const r=await buildPLN(LAST_X);
    const url=URL.createObjectURL(new Blob([r.xml],{type:"application/xml"}));
    const a=document.createElement("a"); a.href=url; a.download=r.file; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
    const msg=`Saved <b>${r.file}</b>: ${r.rules}, ${r.routeType}, ${r.count} waypoint${r.count===1?"":"s"}${r.sid?`, SID ${r.sid}`:""}${r.starId?`, STAR ${r.starId}`:""}${r.apType?`, ${r.apType} approach`:""}.`+
      (r.unknown.length?` <span class="warn">${r.unknown.length} waypoint${r.unknown.length>1?"s":""} without a known ICAO region (${r.unknown.slice(0,6).join(", ")}${r.unknown.length>6?"…":""}) written as user waypoints.</span>`:"")+
      ` In FS2024: World map → flight plan → Load, then pick this file.`;
    document.querySelectorAll(".plnNote").forEach(n=>n.innerHTML=msg);
  }catch(e){ console.error(e); alert("Could not build the .PLN file: "+e.message); }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=label; } }
}
document.addEventListener("click",e=>{ const b=e.target.closest&&e.target.closest("[data-pln]"); if(b){ e.preventDefault(); downloadPLN(b); } });
