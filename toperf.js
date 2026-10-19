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
    kTO:0.85,            // induced drag with takeoff flaps/slats: higher span efficiency than OpenAP's clean polar (as in
                         // OpenAP's non-clean drag model); with it every type meets its certified one-engine-out gradient
                         // at MTOW, sea level, ISA (tests/toperf.test.mjs)
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
      tune:tune&&tune.factor?{factor:tune.factor, altK:tune.altK||0}:null};
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
    // ground distance while true airspeed goes from v0 to v1 (ground speed = airspeed − headwind)
    const roll=(v0,v1,n)=>{ if(v1<=v0) return 0; const dv=(v1-v0)/C.steps; let d=0;
      for(let i=0;i<C.steps;i++){ const v=v0+(i+0.5)*dv, A=acc(v,n); if(A<=0) return Infinity; d+=(v-hw)*dv/A; }
      return d; };
    // climb gradient at V2, gear up, takeoff flaps
    const grad=n=>{ const v=tas(v2), q=0.5*at.rho*v*v, cl=W/(q*S);
      return (T(v,n)-q*S*(ac.cd0+L.dcd0+ac.k*C.kTO*cl*cl))/W; };
    const air=(n,screenFt)=>C.rotateS*(tas(vlof)-hw)+screenFt*FT/Math.max(grad(n),0.005);
    const v0=hw, n=ac.nEng, airOEI=air(n-1,wet?C.screenFt.wetOEI:C.screenFt.dry);
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

  return {acFromModel, fieldLength, isaAt, LEVEL, C};
})();
