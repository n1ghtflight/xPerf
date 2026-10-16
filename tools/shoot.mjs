// Drive headless Edge over CDP: run one flight in the app and screenshot each section.
// usage: node shoot.mjs <outDir> <width> <acId> <dep> <arr> <nav> [alt]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir, width, acId, dep, arr, nav, alt = ""] = process.argv.slice(2);
const W = +width, PORT = 9333;
mkdirSync(outDir, { recursive: true });
const edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(outDir, "_profile")}`,
  `--window-size=${W},900`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch {} await sleep(250); }
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async expr => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 240000 }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 600 });
await send("Page.navigate", { url: `http://localhost:${process.env.XPORT||8765}/` });
await sleep(1500);
const run = `(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<240&&document.getElementById('go').disabled;i++) await wait(500); await window.NAV_READY;
  const s=document.getElementById('ac'); s.value=${JSON.stringify(acId)}; s.dispatchEvent(new Event('change'));
  for(let i=0;i<60&&(!MODEL||MODEL.id!==${JSON.stringify(acId)});i++) await wait(300); await wait(300);
  document.getElementById('nav').value=${JSON.stringify(nav)}; document.getElementById('dep').value=${JSON.stringify(dep)};
  document.getElementById('arr').value=${JSON.stringify(arr)}; document.getElementById('alt').value=${JSON.stringify(alt)};
  document.getElementById('go').click();
  for(let i=0;i<480&&!document.querySelector('.kpis')&&!document.getElementById('err').textContent;i++) await wait(500);
  await wait(4000);
  return document.getElementById('err').textContent; })()`;
const err = await evalJs(run);
// section rectangles: header+form column, then every top-level block in #results
const rects = await evalJs(`(()=>{ const out=[]; const r=e=>{const b=e.getBoundingClientRect();return {x:Math.max(0,b.left+scrollX-4),y:Math.max(0,b.top+scrollY-4),width:b.width+8,height:b.height+8};};
  out.push({name:"00_header",...r(document.querySelector('header'))});
  out.push({name:"01_form",...r(document.querySelector('main > section'))});
  [...document.getElementById('results').children].forEach((c,i)=>{ const h=(c.querySelector('h2')?.innerText||c.className||'block').toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,40); out.push({name:String(i+2).padStart(2,'0')+'_'+h,...r(c)}); });
  const b=document.documentElement; out.push({name:"zz_full",x:0,y:0,width:b.scrollWidth,height:Math.min(b.scrollHeight,16000)});
  return out; })()`);
const layout = await evalJs(`({scrollWidth:document.documentElement.scrollWidth, clientWidth:document.documentElement.clientWidth, height:document.documentElement.scrollHeight})`);
for (const rc of rects) {
  const s = rc.name === "zz_full" ? 0.5 : 1;
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: rc.x, y: rc.y, width: rc.width, height: rc.height, scale: s } });
  if (shot.result?.data) writeFileSync(join(outDir, rc.name + ".png"), Buffer.from(shot.result.data, "base64"));
}
console.log(JSON.stringify({ err, layout, files: rects.map(r => `${r.name} ${Math.round(r.width)}x${Math.round(r.height)}`) }, null, 1));
ws.close(); edge.kill();
process.exit(0);
