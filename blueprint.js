"use strict";
/* =====================================================================
   Aircraft blueprints with no DOM, so they can be unit-tested (tests/blueprint.test.mjs).
   aircraftSpec(facts) → the drawing's geometry: real dimensions where the data has them (OpenAP fuselage,
     wing span / area / sweep; the GA table's wingspan), proportions by class elsewhere, and the layout
     (wing, tail, engine mounting) from BLUEPRINT_TRAITS.
   blueprintSVG(spec) → a top-view line drawing (nose right) on a faint grid with the wingspan dimensioned,
     the length only when it is real data. Colours are the --bp-line / --bp-bg tokens: each part is filled
     with the surface colour, so parts on top hide the ones beneath, as on a drawing.
   ===================================================================== */
// Per type: high = high wing; T = T-tail; rear = engines on the rear fuselage; overwing; tiptanks;
// boom (twin booms) with pushpull (nose + rear propellers); canard and pusher; swNN = wing sweep in degrees.
// Empty = low wing, conventional tail, engines where the engine kind and count suggest.
var BLUEPRINT_TRAITS={
  C150:"high",C152:"high",C172:"high",C177:"high",C182:"high",C206:"high",C207:"high",C210:"high",PA18:"high",
  C208:"high",PC6T:"high",DHC6:"high",C337:"high boom pushpull",
  PA38:"T",PA44:"T",BE76:"T",DA40:"T",DA42:"T",DA50:"T",PC12:"T",BE20:"T",B350:"T",P180:"T canard pusher",
  E50P:"T rear",E55P:"T rear",LJ45:"T rear",LJ60:"T rear",PRM1:"T rear",CL30:"T rear",CL35:"T rear",CL60:"T rear",
  GLF4:"T rear",GLF5:"T rear",GLF6:"T rear",GLEX:"T rear sw35",C750:"T rear sw37",CRJ9:"T rear",E145:"T rear",
  C525:"rear",C25A:"rear",C25B:"rear",C550:"rear",C560:"rear",C56X:"rear",C680:"rear",F2TH:"rear",F900:"rear",FA7X:"rear sw33",
  HDJT:"overwing",C310:"tiptanks",
  BE23:"",BE33:"",BE36:"",BE55:"",BE58:"",BE9L:"",C340:"",C402:"",C414:"",C421:"",C425:"",C441:"",DR40:"",G115:"",
  M20P:"",M20T:"",M600:"",P28A:"",P28R:"",P28T:"",P32R:"",P46T:"",PA23:"",PA27:"",PA31:"",PA32:"",PA34:"",PA46:"",
  RALL:"",SR20:"",SR22:"",TAMP:"",TBM7:"",TBM8:"",TOBA:"",TRIN:"",
  A19N:"",A20N:"",A21N:"",A318:"",A319:"",A320:"",A321:"",A332:"",A333:"",A343:"",A359:"",A388:"",
  B37M:"",B38M:"",B39M:"",B3XM:"",B734:"",B737:"",B738:"",B739:"",B744:"",B748:"",B752:"",B763:"",
  B772:"",B773:"",B77W:"",B788:"",B789:"",E170:"",E190:"",E195:"",E75L:""
};

// facts: {code, kind: piston|turboprop|jet, n, span, length?, width?, area?, sweep?, mount?, mtow?}
var aircraftSpec=function(f){
  const code=String(f.code||"").toUpperCase(), t=BLUEPRINT_TRAITS[code], flags=new Set(String(t??"").split(/\s+/).filter(Boolean));
  const kind=f.kind||"piston", n=Math.max(1,+f.n||1), jet=kind==="jet";
  const span=+f.span||Math.sqrt((+f.mtow||1200)/40)*3, heavy=(+f.mtow||0)>=40000||span>=30;
  const mount=flags.has("rear")?"rear":flags.has("overwing")?"overwing":flags.has("pushpull")?"pushpull"
    :!jet?(n===1?"nose":"wing"):t!=null?(f.mount||"wing"):(f.mount||(heavy?"wing":"rear"));
  const tail=flags.has("T")||(t==null&&jet&&mount==="rear")?"T":"conv", wing=flags.has("high")?"high":"low";
  const ratio=jet?1.02:mount==="pushpull"?0.78:kind==="turboprop"?(n===1?0.84:0.8):wing==="high"?0.76:n===1?0.77:0.82;
  const length=+f.length||span*ratio;
  const sw=[...flags].map(x=>/^sw(\d+)$/.exec(x)).find(Boolean);
  return {code,kind,n,span,length,lengthReal:!!+f.length,
    width:+f.width||length*(jet?0.1:kind==="turboprop"?0.105:n===1?0.13:0.115),
    area:+f.area||span*span/(jet?(heavy?9:8):kind==="turboprop"?9:7.4),
    sweep:f.sweep!=null?+f.sweep:sw?+sw[1]:jet?(heavy?30:25):0,
    taper:jet?(heavy?0.25:0.35):kind==="turboprop"?0.5:0.7,
    wing,tail,mount,heavy,tiptanks:flags.has("tiptanks"),boom:flags.has("boom"),canard:flags.has("canard"),pusher:flags.has("pusher")};
};

var blueprintSVG=function(s,{label}={}){
  const L=s.length, b=s.span, sp=b/2, W=s.width, jet=s.kind==="jet", tp=s.kind==="turboprop";
  const rad=d=>d*Math.PI/180, esc=x=>String(x).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const shapes=[];                                   // {pts:[[x,y]…] in metres, closed, cls, fill}
  const add=(cls,pts,closed=true,fill=true)=>shapes.push({cls,pts,closed,fill});
  const mirror=pts=>pts.map(([x,y])=>[x,-y]);

  // wing: root chord from area and taper, leading-edge sweep from the quarter-chord sweep
  const lam=s.taper, cr=2*s.area/(b*(1+lam)), ct=lam*cr, y0=W*0.45;
  const pos=s.canard?0.42:jet?(s.mount==="rear"?0.56:0.6):tp?(s.n===1?0.62:0.6):s.wing==="high"?0.72:s.n===1?0.68:0.64;
  const xLE=pos*L, dLE=-Math.tan(rad(s.sweep))-(cr-ct)/(4*(sp-y0)), le=y=>xLE+dLE*(Math.abs(y)-y0), ch=y=>cr+(ct-cr)*(Math.abs(y)-y0)/(sp-y0);
  const wingPts=[[xLE,y0],[le(sp),sp],[le(sp)-ct,sp],[xLE-cr,y0],[xLE-cr,-y0],[le(sp)-ct,-sp],[le(sp),-sp],[xLE,-y0]];

  // fuselage: tail cone, parallel cabin, elliptical nose (shorter on a pod with twin booms)
  const tailX=s.boom?0.4*L:0, FL=L-tailX, noseF=jet?0.16:0.11, coneF=jet?0.42:0.5, r0=s.boom?0.55:0.1;
  const r=u=>u<coneF?r0+(1-r0)*Math.sin(u/coneF*Math.PI/2):u<1-noseF?1:Math.sqrt(Math.max(0,1-((u-(1-noseF))/noseF)**2))*0.92+0.08*(u<1?1:0);
  const up=[]; for(let i=0;i<=48;i++){ const u=i/48; up.push([tailX+u*FL,r(u)*W/2]); }
  const fusPts=[...up,...mirror(up).reverse()];

  // tail surfaces
  const sh=(jet&&s.heavy?0.17:0.16)*b, crh=(jet?0.5:0.72)*cr, lh=jet?0.45:0.7, swh=jet?s.sweep+5:3;
  const xh=s.boom?0.02*L:s.tail==="T"?(jet?0.03*L:0.07*L)+crh:(jet?(s.mount==="rear"?0.13:0.16):0.17)*L+crh*0.3;
  const dh=-Math.tan(rad(swh)), stab=[[xh,0.05],[xh+dh*sh,sh],[xh+dh*sh-lh*crh,sh],[xh-crh,0.05],[xh-crh,-0.05],[xh+dh*sh-lh*crh,-sh],[xh+dh*sh,-sh],[xh,-0.05]];
  const xf=(jet?0.27:0.21)*L, fw=Math.max(0.07*W,0.04), fin=[[tailX+0.01*L,0],[tailX+xf*0.45,fw],[tailX+xf,0],[tailX+xf*0.45,-fw]];

  // engines
  // nacelle / pod outline: rounded front (blunt for a jet intake), full width for two thirds, tapered rear
  const capsule=(xf0,xr,y,hw,cls)=>{ const len=xf0-xr, k=cls==="bp-pod"?hw*0.35:Math.min(len*0.2,hw*1.3), side=[];
    for(let i=0;i<=6;i++){ const a=Math.PI/2*i/6; side.push([xf0-k+k*Math.cos(a),y+hw*Math.sin(a)]); }
    side.push([xf0-0.66*len,y+hw],[xr,y+hw*0.55]);
    return {cls,pts:[...side,...side.slice().reverse().map(([x,yy])=>[x,2*y-yy])],closed:true,fill:true}; };
  const props=[], nac=[], pods=[], topPods=[];
  const prop=(x,y,D)=>props.push([[x,y-D/2],[x,y+D/2]]);
  if(s.mount==="nose"||s.mount==="pushpull") prop(L+0.03*L,0,(tp?0.16:0.17)*b);
  if(s.mount==="pushpull") prop(tailX-0.02*L,0,0.15*b);
  if(s.mount==="wing"&&!jet){
    const yN=W/2+(tp?0.11:0.12)*b, len=(tp?0.34:0.3)*L, hw=0.034*b;
    for(const y of [yN,-yN]){ const front=s.pusher?le(y)+0.05*len:le(y)+0.42*len;
      nac.push(capsule(front,front-len,y,hw,"bp-nac"));
      prop(s.pusher?front-len-0.015*L:front+0.015*L,y,(tp?0.14:0.165)*b); }
  }
  if(s.mount==="wing"&&jet){
    const ys=s.n>=4?[0.38,0.68]:[0.34], len=0.14*L, hw=(s.n>=4?0.026:0.035)*b;
    for(const f of ys) for(const y of [f*sp,-f*sp]){ const front=le(y)+0.75*len; pods.push(capsule(front,front-len,y,hw,"bp-pod")); }
  }
  if(s.mount==="overwing"){
    const len=0.2*L, hw=0.03*b;
    for(const y of [0.36*sp,-0.36*sp]){ const front=le(y)-ch(y)*0.45; topPods.push(capsule(front,front-len,y,hw,"bp-pod")); }
  }
  if(s.mount==="rear"){
    const len=(s.heavy?0.17:0.2)*L, hw=(s.heavy?0.022:0.03)*L, x0=(s.tail==="T"?0.34:0.32)*L, y=W/2+hw+0.06*W;
    for(let i=0;i<Math.floor(s.n/2);i++) for(const yy of [y,-y]) pods.push(capsule(x0,x0-len,yy,hw,"bp-pod"));
    if(s.n%2) topPods.push(capsule(x0-0.04*L,x0-0.04*L-len,0,hw*0.9,"bp-pod"));
  }
  const booms=[], tanks=[];
  if(s.boom){ const yB=0.15*b, hw=0.012*b;
    for(const y of [yB,-yB]) booms.push({cls:"bp-boom",pts:[[le(y)-cr*0.3,y+hw],[0.03*L,y+hw*0.6],[0.03*L,y-hw*0.6],[le(y)-cr*0.3,y-hw]],closed:true,fill:true}); }
  if(s.tiptanks){ const len=0.27*L, hw=0.035*b;
    for(const y of [sp,-sp]){ const c=le(sp)-ct/2, pts=[]; for(let i=0;i<24;i++){ const a=2*Math.PI*i/24; pts.push([c+len/2*Math.cos(a),y+hw*Math.sin(a)]); } tanks.push({cls:"bp-tank",pts,closed:true,fill:true}); } }
  const canard=s.canard?[[0.88*L,0.05],[0.875*L,0.13*b],[0.875*L-0.3*cr,0.13*b],[0.88*L-0.38*cr,0.05],[0.88*L-0.38*cr,-0.05],[0.875*L-0.3*cr,-0.13*b],[0.875*L-0.3*cr,-0.13*b],[0.875*L,-0.13*b],[0.88*L,-0.05]]:null;

  // physical stacking order (later hides earlier)
  const S=(cls,pts)=>({cls,pts,closed:true,fill:true});
  const order=[];
  if(s.tail==="conv"&&!s.boom) order.push(S("bp-stab",stab));
  if(s.boom){ const yS=0.15*b+0.02*b, c=0.5*cr, xb=0.1*L;
    order.push(S("bp-stab",[[xb,yS],[xb,-yS],[xb-c,-yS],[xb-c,yS]]),...booms); }
  if(s.wing==="high"){ order.push(S("bp-fus",fusPts),...nac,S("bp-wing",wingPts),...tanks,...booms); }
  else { if(canard) order.push(S("bp-canard",canard)); order.push(S("bp-wing",wingPts),...tanks,...nac,S("bp-fus",fusPts)); }
  order.push(...pods);
  if(s.boom) for(const y of [0.15*b,-0.15*b]) order.push(S("bp-fin",[[0.03*L,y],[0.1*L,y+fw],[0.2*L,y],[0.1*L,y-fw]]));
  else order.push(S("bp-fin",fin));
  if(s.tail==="T") order.push(S("bp-stab",stab));
  order.push(...topPods);
  shapes.push(...order);

  // fit into a 400 × 300 view, nose up (span across, as on a plan view): drawing 28–372 × 34–262,
  // span dimensioned just above the wingtips (visible when the drawing is cropped), a real length on the right
  let x0=Infinity,x1=-Infinity,ym=0;
  for(const sh of [...shapes,...props.map(pts=>({pts}))]) for(const [x,y] of sh.pts){ x0=Math.min(x0,x); x1=Math.max(x1,x); ym=Math.max(ym,Math.abs(y)); }
  const k=Math.min(344/(2*ym),228/(x1-x0)), top=34+(228-(x1-x0)*k)/2;
  const X=y=>(200+y*k).toFixed(1), Y=x=>(top+(x1-x)*k).toFixed(1);
  const d=pts=>pts.map(([x,y],i)=>`${i?"L":"M"}${X(y)} ${Y(x)}`).join("")+"Z";
  const line=`stroke="var(--bp-line)" stroke-linejoin="round" vector-effect="non-scaling-stroke"`;
  const txt=(x,y,t,rot)=>`<text x="${x}" y="${y}"${rot?` transform="rotate(-90 ${x} ${y})"`:""} text-anchor="middle" font-size="11" fill="var(--bp-line)" fill-opacity=".6">${t}</text>`;
  let grid=""; for(let g=20;g<400;g+=20) grid+=`M${g} 0V300`; for(let g=20;g<300;g+=20) grid+=`M0 ${g}H400`;
  const body=shapes.map(sh=>`<path class="${sh.cls}" d="${d(sh.pts)}" fill="var(--bp-bg)" ${line} stroke-opacity=".5" stroke-width="1.1"/>`).join("")+
    props.map(p=>`<path class="bp-prop" d="M${X(p[0][1])} ${Y(p[0][0])}L${X(p[1][1])} ${Y(p[1][0])}" ${line} stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/>`).join("");
  const sl=X(-sp), sr=X(sp);
  const dy=(+Y(le(sp))-14).toFixed(1);
  let dims=`<path d="M${sl} ${dy}H${sr}M${sl} ${dy-6}V${+dy+6}M${sr} ${dy-6}V${+dy+6}" ${line} stroke-opacity=".4" stroke-width=".7" fill="none"/>`+
    txt(((+sl+200)/2).toFixed(1),(dy-5).toFixed(1),`${b.toFixed(2)} m`);
  if(s.lengthReal){ const n=Y(L), t=Y(0);
    dims+=`<path d="M372 ${n}V${t}M366 ${n}H378M366 ${t}H378" ${line} stroke-opacity=".4" stroke-width=".7" fill="none"/>`+txt(386,((+n+ +t)/2).toFixed(1),`${L.toFixed(2)} m`,true); }
  return `<svg class="bp" viewBox="0 0 400 300" preserveAspectRatio="xMaxYMid meet" aria-hidden="true" focusable="false">`+
    `<path d="${grid}" stroke="var(--bp-line)" stroke-opacity=".08" stroke-width=".6" vector-effect="non-scaling-stroke" fill="none"/>`+
    `<path d="M200 ${Y(x1)}V${Y(x0)}" stroke="var(--bp-line)" stroke-opacity=".28" stroke-width=".7" stroke-dasharray="8 4 2 4" vector-effect="non-scaling-stroke" fill="none"/>`+
    body+dims+`<text x="14" y="20" font-size="11" fill="var(--bp-line)" fill-opacity=".55">${esc(label||s.code)} · top view</text></svg>`;
};
