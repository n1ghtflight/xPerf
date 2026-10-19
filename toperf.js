"use strict";
/* =====================================================================
   Takeoff performance model (generic transport-category jet). Pure functions, no DOM.
   Per-type inputs: OpenAP (wing, polar, engines) + data/to_ref.json (approach speed at max landing weight,
   flap settings) + data/to_tune.json (field-length tuning to manufacturer airport-planning charts).
   Everything else is a generic constant, named below with its reason. An estimate for simulation only:
   not certified data, no obstacles, no VMCG/VMCA/VMBE/tyre-speed limits.
   Speeds in and out are kt CAS (taken as EAS at airport altitudes); the ground run integrates true airspeed.
   ===================================================================== */
var TOPerf=(()=>{
  const G=9.80665, KT=0.514444, FT=0.3048, R=287.053, RHO0=1.225;
  // Takeoff flap levels: CLmax as a fraction of the landing-flap CLmax (takeoff flaps trade lift for climb
  // gradient), the flap drag increment, and the lift coefficient during the ground roll (attitude ~0°).
  const LEVEL={
    low: {clFrac:0.78, dcd0:0.012, clGround:0.55},
    mid: {clFrac:0.83, dcd0:0.020, clGround:0.65},
    high:{clFrac:0.88, dcd0:0.030, clGround:0.75}};
  const C={
    vrefFactor:1.23,     // VREF = 1.23 VSR in landing configuration (CS/FAR 25.125)
    v2Factor:1.13,       // V2 ≥ 1.13 VSR (CS/FAR 25.107)
    dVRkt:6,             // VR a few kt below V2: the aircraft accelerates through rotation and lift-off to 35 ft
    vrMinFactor:1.05,    // VR ≥ 1.05 VMU-ish floor, so VR never drops to the stall speed
    v1FloorVR:0.9,       // stand-in for VMCG (not modelled): V1 not below 90 % of VR
    muRoll:{dry:0.02,wet:0.025},     // rolling friction, paved runway
    muBrake:{dry:0.40,wet:0.20},     // max braking (anti-skid), wet about half of dry
    revCreditWet:0.03,   // reverse thrust may be credited on wet runways only (CS 25.109)
    stopDelayS:2,        // 2 s distance at V1 before braking (CS/FAR 25.109)
    rotateS:3,           // rotation and transition time at lift-off speed
    screenFt:{dry:35,wetOEI:15},     // screen height; 15 ft for the one-engine-out wet case (CS/FAR 25.113)
    flatRateIsa:15,      // engines flat-rated to ISA+15 at the field
    lapsePerC:0.008,     // full thrust falls ~0.8 %/°C above the flat-rating temperature
    gearCd0:0.017,       // landing-gear drag when OpenAP has none
    kTO:0.78,            // induced drag with takeoff flaps/slats, relative to OpenAP's clean polar: flaps raise span efficiency
                         // (as in OpenAP's non-clean drag model). Calibrated so every type keeps ≥ 0.3 points above its
                         // certified one-engine-out gradient at MTOW, sea level, ISA, packs on (tests/toperf.test.mjs) —
                         // certified airliners are field-limited there, not climb-limited
    steps:200};          // integration steps per ground-run segment

  const isaAt=paFt=>15-1.98*paFt/1000;
  function atm(paFt,oatC){
    const p=101325*Math.pow(1-2.25577e-5*paFt*FT,5.25588), T=oatC+273.15, rho=p/(R*T);
    return {p, rho, a:Math.sqrt(1.4*R*T), delta:p/101325, sigma:rho/RHO0};
  }
  // full takeoff thrust per engine (N): Bartel & Young (2008) speed/pressure lapse as implemented in OpenAP
  // thrust.takeoff, times a flat-rating temperature lapse evaluated at the (assumed) temperature
  function thrust(ac,mach,delta,paFt,tempC){
    const b=ac.bpr, G0=0.0606*b+0.6337, d=delta;
    const A=-0.4327*d*d+1.3855*d+0.0472, Z=0.9106*d**3-1.7736*d*d+1.8697*d, X=0.1377*d**3-0.4374*d*d+1.3003*d;
    const ratio=A-0.377*(1+b)/Math.sqrt((1+0.82*b)*G0)*Z*mach+(0.23+0.19*Math.sqrt(b))*X*mach*mach;
    const over=Math.max(0,tempC-(isaAt(paFt)+C.flatRateIsa));
    return ac.thrust0*Math.max(ratio,0)*Math.max(1-C.lapsePerC*over,0);
  }

  // XPerf's OpenAP model (m) + to_ref entry + optional to_tune entry → the aircraft data the model reads.
  // to_ref may name a takeoff engine where OpenAP's default is a low-thrust variant the type isn't flown with.
  function acFromModel(m,ref,tune){
    const a=m.ac;
    return {code:m.code, nEng:m.nEng, S:a.wing.area, cd0:m.polar.cd0, k:m.polar.k, gearCd0:a.drag?.gears??C.gearCd0,
      mtow:a.mtow, mlw:a.mlw, malwKg:ref.malwKg??null, span:a.wing.span, length:a.fuselage?.length??a.wing.span,
      thrust0:ref.engine?.thrustN??m.eng.max_thrust, bpr:ref.engine?.bpr??(m.eng.bpr||5), engEstimated:!ref.engine&&!!m.eng.estimated,
      engine:ref.engine?.name??m.eng.name,
      vrefMLW:ref.vrefMLW.v, vrefSrc:ref.vrefMLW.s, family:ref.family, label:ref.label, flaps:ref.flaps,
      tune:tune&&tune.factor?{factor:tune.factor, altK:tune.altK||0}:null,
      landingFlaps:ref.landingFlaps||[{name:"FULL",frac:1,default:true}], autobrake:ref.autobrake||[{name:"Max manual",decel:null}],
      vappRule:ref.vapp||"boeing", tuneLdg:tune?.landing?.factor?{factor:tune.landing.factor, altK:tune.landing.altK||0}:null};
  }

  // Balanced field length at one flap level and one (assumed) temperature.
  // env: {massKg, paFt, oat, hwKt (+head, already 50 %/150 % factored), slopePct (+uphill), wet, bleed (thrust ×)}
  function fieldLength(ac,env,level,assumedT){
    const L=LEVEL[level], at=atm(env.paFt,env.oat), m=env.massKg, W=m*G, S=ac.S, wet=!!env.wet;
    const tas=eas=>eas/Math.sqrt(at.sigma), hw=env.hwKt*KT, slopeG=W*env.slopePct/100, bleed=env.bleed??1;
    // speeds (EAS): CLmax from the published approach speed at max landing weight
    const clLand=2*(ac.malwKg||ac.mlw)*G/(RHO0*S*(ac.vrefMLW*KT/C.vrefFactor)**2), clmax=clLand*L.clFrac;
    const vs=Math.sqrt(2*W/(RHO0*S*clmax)), v2=C.v2Factor*vs, vr=Math.max(v2-C.dVRkt*KT,C.vrMinFactor*vs), vlof=(vr+v2)/2;
    const T=(v,n)=>n*thrust(ac,Math.abs(v)/at.a,at.delta,env.paFt,assumedT)*bleed;
    const cdG=ac.cd0+L.dcd0+ac.gearCd0+ac.k*C.kTO*L.clGround**2, mu=wet?C.muRoll.wet:C.muRoll.dry;
    const acc=(v,n)=>{ const q=0.5*at.rho*v*Math.abs(v);
      return (T(v,n)-q*S*cdG-mu*Math.max(W-q*S*L.clGround,0)-slopeG)/m; };
    // ground distance while true airspeed goes from v0 to v (ground speed = airspeed − headwind), integrated once
    // per engine count into a cumulative table and interpolated, so the V1 search costs nothing extra
    const v0=hw, vEnd=Math.max(tas(vlof),v0+1), dv=(vEnd-v0)/C.steps;
    const table=n=>{ const d=new Float64Array(C.steps+1);
      for(let i=0;i<C.steps;i++){ const v=v0+(i+0.5)*dv, A=acc(v,n); d[i+1]=A>0&&d[i]<Infinity?d[i]+(v-hw)*dv/A:Infinity; }
      return d; };
    const tabAEO=table(ac.nEng), tabOEI=table(ac.nEng-1);
    // Infinity in a table = cannot accelerate past that speed; never let Infinity−Infinity or Infinity×0 make NaN
    const at_=(tab,v)=>{ const x=Math.min(Math.max((v-v0)/dv,0),C.steps), i=Math.min(Math.floor(x),C.steps-1);
      if(!Number.isFinite(tab[i])||(x>i&&!Number.isFinite(tab[i+1]))) return Infinity;
      return tab[i]+(tab[i+1]-tab[i])*(x-i); };
    const roll=(va,vb,n)=>{ if(vb<=va) return 0; const tab=n===ac.nEng?tabAEO:tabOEI, b=at_(tab,vb);
      return Number.isFinite(b)?b-at_(tab,va):Infinity; };
    // climb gradient at V2, gear up, takeoff flaps
    const grad=n=>{ const v=tas(v2), q=0.5*at.rho*v*v, cl=W/(q*S);
      return (T(v,n)-q*S*(ac.cd0+L.dcd0+ac.k*C.kTO*cl*cl))/W; };
    // no climb gradient → the screen height is never reached
    const air=(n,screenFt)=>{ const g=grad(n); return g>0?C.rotateS*(tas(vlof)-hw)+screenFt*FT/g:Infinity; };
    const n=ac.nEng, airOEI=air(n-1,wet?C.screenFt.wetOEI:C.screenFt.dry);
    const brake=G*((wet?C.muBrake.wet+C.revCreditWet:C.muBrake.dry)+env.slopePct/100);
    const go=v1=>roll(v0,tas(v1),n)+roll(tas(v1),tas(vlof),n-1)+airOEI;
    const stop=v1=>{ const gs=tas(v1)-hw; return roll(v0,tas(v1),n)+C.stopDelayS*gs+gs*gs/(2*Math.max(brake,0.05)); };
    // balanced V1: go(V1) falls and stop(V1) rises with V1; bisect where they meet, within [floor, VR]
    let lo=C.v1FloorVR*vr, hi=vr, v1;
    if(go(lo)<=stop(lo)) v1=lo; else if(go(hi)>=stop(hi)) v1=hi;
    else { for(let i=0;i<30;i++){ const mid=(lo+hi)/2; if(go(mid)>stop(mid)) lo=mid; else hi=mid; } v1=(lo+hi)/2; }
    const goM=go(v1), stopM=stop(v1), aeo115M=1.15*(roll(v0,tas(vlof),n)+air(n,C.screenFt.dry));
    return {vs:vs/KT, v1:v1/KT, vr:vr/KT, v2:v2/KT, requiredM:Math.max(goM,stopM,aeo115M), goM, stopM, aeo115M,
      v1DistM:roll(v0,tas(v1),n), grad2:grad(n-1)};
  }

  const BLEED={packs:0.985, antiIce:{off:1, eng:0.98, wing:0.96}};   // generic thrust bleed penalties
  const GRAD2_MIN=[0,0,0.024,0.027,0.030];                          // CS/FAR 25.121(b), by engine count
  const M2FT=1/FT, MIN_THRUST=0.75, MAX_ISA=55;                     // AC 25-13: ≥ 75 % of full thrust; assumed temp ≤ ISA+55

  // Everything for one takeoff: every flap setting, reduced-thrust temperature, limits, the setting to show.
  // input: {towKg, elevFt, qnh, oat, windKt (+head, raw), slopePct, lengthFt, intersectionFt, lineup "none"|"90"|"180",
  //         wet, packs, antiIce "off"|"eng"|"wing", thrust "reduced"|"full", flap "optimum"|name}
  function compute(ac,input){
    const num=(v,d=0)=>Number.isFinite(+v)&&v!==""&&v!=null?+v:d;
    // out-of-range numbers fall back to standard values (the view also refuses them), so nothing turns NaN
    const rng=(v,lo,hi,d)=>{ const x=num(v,d); return x>=lo&&x<=hi?x:d; };
    const paFt=rng(input.elevFt,-1500,15000,0)+(1013.25-rng(input.qnh,850,1100,1013.25))*27, oat=rng(input.oat,-60,60,isaAt(paFt)), wind=rng(input.windKt,-60,60,0);
    const env={massKg:Math.min(rng(input.towKg,0.2*ac.mtow,Infinity,ac.mtow),2*ac.mtow), paFt, oat, hwKt:wind>=0?0.5*wind:1.5*wind, slopePct:rng(input.slopePct,-5,5,0), wet:!!input.wet,
      bleed:(input.packs===false?1:BLEED.packs)*(BLEED.antiIce[input.antiIce]||1)};
    const lineupFt=({"90":ac.length,"180":ac.span}[input.lineup]||0)*M2FT;
    const availableFt=Math.max(0,num(input.lengthFt)-Math.max(0,num(input.intersectionFt))-lineupFt);
    const tune=ac.tune?ac.tune.factor*(1+ac.tune.altK*paFt/1000):1, gMin=GRAD2_MIN[ac.nEng]||0.024;
    const at=atm(paFt,oat), full=thrust(ac,0,at.delta,paFt,oat);
    const tLo=Math.ceil(Math.max(oat,isaAt(paFt)+C.flatRateIsa))+1,   // strictly above OAT and the flat-rating point
      tHi=Math.floor(isaAt(paFt)+MAX_ISA);
    const evalAt=(level,T)=>{ const r=fieldLength(ac,env,level,T), red=1-thrust(ac,0,at.delta,paFt,T)/full;
      const req=r.requiredM*tune*M2FT, fieldOK=req<=availableFt, climbOK=r.grad2>=gMin, thrustOK=red<=1-MIN_THRUST+1e-9;
      return {r,red,req,fieldOK,climbOK,thrustOK,ok:fieldOK&&climbOK&&thrustOK}; };
    const byFlap=ac.flaps.map(f=>{
      let e=evalAt(f.level,oat), assumedT=null;
      if(input.thrust!=="full" && e.ok && tLo<=tHi){
        let lo=tLo, hi=tHi;
        if(evalAt(f.level,lo).ok){
          if(evalAt(f.level,hi).ok) lo=hi;
          else while(hi-lo>1){ const mid=(lo+hi)>>1; if(evalAt(f.level,mid).ok) lo=mid; else hi=mid; }
          assumedT=lo; e=evalAt(f.level,lo); } }
      const {r}=e;
      return {flap:f.name, level:f.level, v1:r.v1, vr:r.vr, v2:r.v2, assumedT, thrustRed:assumedT==null?0:e.red,
        requiredFt:e.req, availableFt, goFt:r.goM*tune*M2FT, stopFt:r.stopM*tune*M2FT, v1Ft:r.v1DistM*tune*M2FT,
        grad2:r.grad2, grad2Min:gMin, fits:e.fieldOK&&e.climbOK,
        status:assumedT!=null?"reduced":e.fieldOK&&e.climbOK?"toga":"nofit",
        limits:[{id:"field", ok:e.fieldOK, text:Number.isFinite(e.req)?`${Math.round(e.req)} of ${Math.round(availableFt)} ft`:"cannot accelerate / climb on one engine"},
                {id:"grad2", ok:e.climbOK, text:`${(r.grad2*100).toFixed(1)} % (min ${(gMin*100).toFixed(1)} %)`},
                {id:"thrust", ok:e.thrustOK, text:`−${Math.round((assumedT==null?0:e.red)*100)} % (max 25 %)`}]};
    });
    // optimum: highest reduced-thrust temperature (ties → lower flap); else the fitting setting with the most margin;
    // else the one closest to fitting
    const margin=x=>x.availableFt-x.requiredFt;
    const pick=byFlap.filter(x=>x.assumedT!=null).sort((p,q)=>q.assumedT-p.assumedT)[0]
      ||byFlap.filter(x=>x.fits).sort((p,q)=>margin(q)-margin(p))[0]
      ||byFlap.slice().sort((p,q)=>(q.grad2>=q.grad2Min)-(p.grad2>=p.grad2Min)||margin(q)-margin(p))[0];
    const selected=input.flap&&input.flap!=="optimum"&&byFlap.find(x=>x.flap===input.flap)||pick;
    const notes=[];
    if(ac.engEstimated) notes.push("Engine thrust estimated — results less certain");
    if(ac.vrefSrc==="est") notes.push("Approach speed estimated — speeds less certain");
    if(env.massKg>ac.mtow) notes.push("Takeoff weight above MTOW");
    return {byFlap, optimum:pick.flap, selected, status:selected.status, shortfallFt:Math.max(0,selected.requiredFt-selected.availableFt),
      notes, paFt, tuned:!!ac.tune};
  }

  // Model vs manufacturer chart points (full thrust, dry, calm, level, packs off, best flap — the charts' conditions).
  // point: {massKg, paFt, isaDev, lengthFt}; the model includes ac.tune when set.
  function tuningReport(ac,points){
    return points.map(pt=>{
      const r=compute(ac,{towKg:pt.massKg, elevFt:pt.paFt, qnh:1013.25, oat:isaAt(pt.paFt)+pt.isaDev, windKt:0, slopePct:0,
        lengthFt:30000, intersectionFt:0, lineup:"none", wet:false, packs:false, antiIce:"off", thrust:"full", flap:"optimum"});
      const modelFt=r.selected.requiredFt;
      return {point:pt, modelFt, chartFt:pt.lengthFt, errPct:(modelFt/pt.lengthFt-1)*100};
    });
  }

  /* ---------------------------------------------------------------- landing */
  const LDG={
    vrefFactor:1.23,          // VREF = 1.23 VSR in the landing configuration (CS/FAR 25.125)
    glideDeg:3,               // certified (dispatch) air distance: 50 ft screen down a 3° path, as in flight-test data
    opAirS:7,                 // operational air distance ≈ 7 s from the threshold (FAA AC 25-32 style: float, flare)
    tdFactor:0.97,            // touchdown speed ≈ 97 % of the threshold speed (speed bled off in the flare)
    transS:1,                 // ground spoilers / brakes coming in after touchdown
    muBrake:{dry:0.45,wet:0.225},  // max anti-skid braking incl. ground-spoiler drag; wet about half of dry
    rev:{max:0.06,idle:0.015,none:0},   // reverse-thrust deceleration credit (g); only helps where braking is the limit
    dispatchDiv:0.6,          // dispatch: actual distance must fit in 60 % of LDA (CS/FAR 121.195(b) style) …
    dispatchWet:1.15,         // … and 115 % of that on a wet runway (121.195(d))
    arrivalFactor:1.15};      // time-of-arrival check: actual × 1.15 (FAA TALPA / EASA)
  const num=(v,d=0)=>Number.isFinite(+v)&&v!==""&&v!=null?+v:d;
  const rng=(v,lo,hi,d)=>{ const x=num(v,d); return x>=lo&&x<=hi?x:d; };

  // input: {lwKg, elevFt, qnh, oat, windKt (+head, raw), gustKt (gust − steady), slopePct (+uphill), ldaFt, wet,
  //         reverse "max"|"idle"|"none", flap "default"|name, autobrake "suggested"|name}
  function computeLanding(ac,input){
    const paFt=rng(input.elevFt,-1500,15000,0)+(1013.25-rng(input.qnh,850,1100,1013.25))*27, oat=rng(input.oat,-60,60,isaAt(paFt));
    const hw=rng(input.windKt,-60,60,0), gust=rng(input.gustKt,0,60,0), slope=rng(input.slopePct,-5,5,0), wet=!!input.wet;
    const mass=Math.min(rng(input.lwKg,0.2*ac.mlw,Infinity,ac.mlw),2*ac.mtow), ldaFt=Math.max(0,num(input.ldaFt));
    const at=atm(paFt,oat), W=mass*G, tas=eas=>eas/Math.sqrt(at.sigma), hwF=(hw>=0?0.5*hw:1.5*hw)*KT;
    const flap=input.flap&&input.flap!=="default"&&ac.landingFlaps.find(f=>f.name===input.flap)||ac.landingFlaps.find(f=>f.default)||ac.landingFlaps[0];
    const clLand=2*(ac.malwKg||ac.mlw)*G/(RHO0*ac.S*(ac.vrefMLW*KT/C.vrefFactor)**2);
    const vref=LDG.vrefFactor*Math.sqrt(2*W/(RHO0*ac.S*clLand*flap.frac))/KT;
    const additive=ac.vappRule==="airbus"?Math.max(5,Math.min(15,Math.max(hw,0)/3)):Math.max(5,Math.min(20,0.5*Math.max(hw,0)+gust));
    // chart tuning applies to the certified (dispatch) distance only — that is what the charts show
    const vapp=vref+additive, tune=ac.tuneLdg?ac.tuneLdg.factor*(1+ac.tuneLdg.altK*paFt/1000):1, M2FT=1/FT;
    // distance from 50 ft at threshold speed vthKt to a stop; decel = autobrake target (m/s²) or null = max braking;
    // cert = certified air distance (dispatch), else the longer operational one
    const dist=(vthKt,decel,rev,mu,cert)=>{
      const gs=Math.max(tas(vthKt*LDG.tdFactor*KT)-hwF,1);
      const air=cert?50*FT/Math.tan(LDG.glideDeg*Math.PI/180):LDG.opAirS*gs, trans=LDG.transS*gs;
      const cap=G*(mu+LDG.rev[rev]+slope/100), a=decel==null?cap:Math.min(decel,cap);
      return {air, total:a>0?air+trans+gs*gs/(2*a):Infinity};
    };
    const mu=wet?LDG.muBrake.wet:LDG.muBrake.dry, rev=LDG.rev[input.reverse]!=null?input.reverse:"idle";
    // the steady-wind part of the additive is bled off approaching the threshold (Boeing keeps the gust part,
    // Airbus the 5 kt), so a headwind shortens the landing rather than lengthening it
    const vth=Math.min(vapp,vref+(ac.vappRule==="airbus"?5:Math.max(5,gust)));
    const byAutobrake=ac.autobrake.map(b=>{ const d=dist(vth,b.decel,rev,mu), actualFt=d.total*M2FT, arrivalFt=actualFt*LDG.arrivalFactor;
      return {name:b.name, decel:b.decel, actualFt, arrivalFt, fits:arrivalFt<=ldaFt}; });
    const dispatchFt=dist(vref,null,"none",LDG.muBrake.dry,true).total*tune*M2FT/LDG.dispatchDiv*(wet?LDG.dispatchWet:1);
    const sug=byAutobrake.find(b=>b.fits)||null;
    const selected=input.autobrake&&input.autobrake!=="suggested"&&byAutobrake.find(b=>b.name===input.autobrake)||sug||byAutobrake[byAutobrake.length-1];
    const dispatchOK=dispatchFt<=ldaFt, status=!selected.fits?"nofit":!dispatchOK?"tight":"ok";
    const notes=[];
    if(ac.engEstimated) notes.push("Engine thrust estimated — results less certain");
    if(ac.vrefSrc==="est") notes.push("Approach speed estimated — speeds less certain");
    if(mass>ac.mlw) notes.push("Landing weight above MLW");
    return {flap:flap.name, vref, vapp, additive, byAutobrake, suggested:sug?sug.name:null, selected, dispatchFt, dispatchOK, ldaFt,
      airFt:dist(vth,null,rev,mu).air*M2FT, status, notes, paFt, tuned:!!ac.tuneLdg};
  }

  // Dispatch landing distance vs manufacturer landing-field-length charts (ISA + isaDev, calm, level, default flap).
  // point: {massKg, paFt, isaDev, wet, lengthFt}; the model includes ac.tuneLdg when set.
  function landingTuningReport(ac,points){
    return points.map(pt=>{
      const r=computeLanding(ac,{lwKg:pt.massKg, elevFt:pt.paFt, qnh:1013.25, oat:isaAt(pt.paFt)+(pt.isaDev||0), windKt:0, gustKt:0,
        slopePct:0, ldaFt:30000, wet:!!pt.wet, reverse:"none", flap:"default", autobrake:"suggested"});
      return {point:pt, modelFt:r.dispatchFt, chartFt:pt.lengthFt, errPct:(r.dispatchFt/pt.lengthFt-1)*100};
    });
  }

  return {acFromModel, fieldLength, compute, computeLanding, tuningReport, landingTuningReport, isaAt, LEVEL, C, LDG};
})();
