// Headless Edge/Chrome over CDP for XPerf's test tools (Node 22+, no npm deps).
// launch() → page at about:blank; enable record()/replay() BEFORE page.goto() so every
// network answer the plan depends on (weather, terrain, airport info, OpenAP, EUROCONTROL) is captured
// or replayed, which makes runs deterministic even though live data changes hourly.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ETD = "2026-10-20T12:00";
export const FLIGHTS = {
  c172: { ac: "apm:C172", dep: "KPAO", arr: "KTRK", nav: "direct" },
  sr22: { ac: "apm:SR22", dep: "EGTF", arr: "LFPN", nav: "direct" },
  b789: { ac: "oap:b789", dep: "KJFK", arr: "EGLL", nav: "awy" },
};

const BROWSERS = [process.env.BROWSER,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CDP returns decoded bodies, so encoding/length headers from the original response must not be re-sent.
const cleanHeaders = hs => (hs || []).filter(h => !/^(content-encoding|content-length|transfer-encoding)$/i.test(h.name));

// Responses that are part of the app itself (or big, AIRAC-stable data) are not recorded.
function passThrough(url, origin) {
  if (!url.startsWith(origin)) return /^(data|blob|chrome-extension|extension):/.test(url);
  const path = new URL(url).pathname;
  if (path.startsWith("/packs/")) return true;
  if (/^\/api\/(airports|navaids|airways|health)$/.test(path)) return true;
  return !path.startsWith("/api/");
}

// Profiles left by crashed or killed runs: remove the ones older than an hour (a live run's are newer).
function sweepProfiles() {
  for (const d of readdirSync(tmpdir())) {
    if (!d.startsWith("xperf-cdp-")) continue;
    const p = join(tmpdir(), d);
    try { if (Date.now() - statSync(p).mtimeMs > 3600e3) rmSync(p, { recursive: true, force: true }); } catch {}
  }
}
let swept = false;
// calls still waiting for the browser (for diagnosing a stalled run): id → { method, since, what }
export const inFlight = new Map();
let callSeq = 0;

export async function launch({ width = 1440, height = 900, mobile = false, scheme = "dark", port = 8770, query = "" } = {}) {
  if (!swept) { swept = true; sweepProfiles(); }
  const exe = BROWSERS.find(p => existsSync(p));
  if (!exe) throw new Error("no Chromium browser found; set BROWSER");
  const dbg = 9500 + Math.floor(Math.random() * 400), prof = mkdtempSync(join(tmpdir(), "xperf-cdp-"));
  // extensions (some are force-installed by machine policy) inject scripts and requests that are not the app's
  const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", "--disable-component-extensions-with-background-pages", `--remote-debugging-port=${dbg}`,
    `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
  let list;
  for (let i = 0; i < 80 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); } catch { await sleep(250); } }
  if (!list) throw new Error("browser did not expose CDP");
  const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
  // a stalled browser must fail loudly, naming the call, instead of hanging the run
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error("CDP connection did not open in 15 s")), 15000);
    ws.addEventListener("open", () => { clearTimeout(t); ok(); }); ws.addEventListener("error", () => { clearTimeout(t); no(new Error("CDP connection failed")); }); });
  let id = 0; const pending = new Map(), handlers = new Map();
  ws.addEventListener("close", () => { for (const p of pending.values()) p.fail(new Error("browser connection lost")); pending.clear(); });
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).done(m); pending.delete(m.id); }
    else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params);
  });
  // every call gets an answer or a named error: Runtime.evaluate may run as long as its own timeout, others 60 s
  const send = (method, params = {}) => new Promise((ok, no) => {
    const i = ++id, ms = method === "Runtime.evaluate" ? (params.timeout || 60000) + 15000 : 60000, key = ++callSeq;
    inFlight.set(key, { method, since: Date.now(), what: String(params.expression || params.url || "").replace(/\s+/g, " ").slice(0, 90) });
    const end = () => { clearTimeout(t); inFlight.delete(key); };
    const t = setTimeout(() => { pending.delete(i); inFlight.delete(key); no(new Error(`CDP ${method} got no answer in ${ms / 1000} s`)); }, ms);
    pending.set(i, { done: m => { end(); ok(m); }, fail: e => { end(); no(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const origin = `http://localhost:${port}`;

  const page = {
    origin, send, on: (ev, fn) => handlers.set(ev, fn), misses: [],
    async goto(path = "/") { await send("Page.navigate", { url: origin + path + (query ? (path.includes("?") ? "&" : "?") + query : "") }); await sleep(1200); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 300000 });
      if (r.result?.exceptionDetails) throw new Error("page error: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result?.result?.value;
    },
    async key(key, { ctrl = false, shift = false } = {}) {
      const mods = (ctrl ? 2 : 0) | (shift ? 8 : 0), code = key.length === 1 ? "Key" + key.toUpperCase() : key;
      const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9 })[key] || 0;
      const text = key.length === 1 && !ctrl ? key : key === "Enter" ? "\r" : undefined;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
    },
    async click(selector) {
      const ok = await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return false; e.scrollIntoView({block:"center"}); e.click(); return true;})()`);
      if (!ok) throw new Error("click: no element " + selector);
    },
    // touch tap at the centre of the first matching element (or at x,y when given numbers)
    async tap(selector, y) {
      const p = typeof selector === "number" ? { x: selector, y } : await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      if (!p) throw new Error("tap: no element " + selector);
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await sleep(120);
    },
    async type(selector, text) {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      for (const ch of text) await page.key(ch);
    },
    async shot(file) { const { result } = await send("Page.captureScreenshot", { format: "png" }); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(result.data, "base64")); },
    async setScheme(s) {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s }, { name: "prefers-reduced-motion", value: "reduce" }] });
      // emulation applies asynchronously: wait until the page's media query reports the new scheme
      for (let i = 0; i < 40; i++) { if (await page.eval(`matchMedia('(prefers-color-scheme: ${s})').matches`).catch(() => true)) break; await sleep(50); }
      await sleep(50);
    },
    async setViewport(w, h, mob = false) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mob ? 2 : 1, mobile: mob }); await send("Emulation.setTouchEmulationEnabled", { enabled: mob, maxTouchPoints: mob ? 5 : 0 }); },
    async close() {
      try { ws.close(); } catch {}
      // the whole process tree: Edge's renderer / GPU children can outlive the parent on Windows
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); else proc.kill();
      for (let i = 0; i < 10; i++) { try { rmSync(prof, { recursive: true, force: true }); break; } catch { await sleep(200); } }
    },
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.setViewport(width, height, mobile); await page.setScheme(scheme);
  return page;
}

// Record every non-app response (status, headers, body) to `file`, keyed by "METHOD url".
export async function record(page, file) {
  const store = {};
  // Pause every request; app files and big static data continue untouched, everything else also
  // pauses at the response stage so its body can be stored. (Holding a multi-MB app response at the
  // response stage stalls Chromium, so those must never be response-intercepted.)
  page.on("Fetch.requestPaused", async p => {
    const { requestId, request } = p, key = request.method + " " + request.url;
    const atResponse = p.responseStatusCode !== undefined || p.responseErrorReason !== undefined;
    if (!atResponse) return page.send("Fetch.continueRequest", { requestId, interceptResponse: !passThrough(request.url, page.origin) });
    if (p.responseErrorReason) { store[key] = { error: p.responseErrorReason }; return page.send("Fetch.continueRequest", { requestId }); }
    const r = await page.send("Fetch.getResponseBody", { requestId });
    const body = r.result ? (r.result.base64Encoded ? r.result.body : Buffer.from(r.result.body).toString("base64")) : "";
    store[key] = { status: p.responseStatusCode, headers: cleanHeaders(p.responseHeaders), bodyBase64: body };
    await page.send("Fetch.fulfillRequest", { requestId, responseCode: p.responseStatusCode, responseHeaders: cleanHeaders(p.responseHeaders), body });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return { save() { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(store)); return Object.keys(store).length; } };
}

// Serve recorded responses; unknown non-app requests fail and are listed in page.misses.
export async function replay(page, file) {
  if (!existsSync(file)) throw new Error(`missing fixtures ${file} (run: node tools/regress.mjs record)`);
  const store = JSON.parse(readFileSync(file, "utf8"));
  page.on("Fetch.requestPaused", async ({ requestId, request }) => {
    if (passThrough(request.url, page.origin)) return page.send("Fetch.continueRequest", { requestId });
    const hit = store[request.method + " " + request.url];
    if (!hit) { page.misses.push(request.method + " " + request.url); return page.send("Fetch.failRequest", { requestId, errorReason: "Failed" }); }
    if (hit.error) return page.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
    await page.send("Fetch.fulfillRequest", { requestId, responseCode: hit.status, responseHeaders: hit.headers, body: hit.bodyBase64 });
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

// Drive the existing form exactly like a user (the way tools/shoot.mjs does) and wait for the result.
export async function planFlight(page, f, { etd = ETD, alt = "" } = {}) {
  return page.eval(`(async()=>{ const wait=ms=>new Promise(r=>setTimeout(r,ms)), $=id=>document.getElementById(id);
    for(let i=0;i<240&&$('go').disabled;i++) await wait(250); await window.NAV_READY;
    const s=$('ac'); s.value=${JSON.stringify(f.ac)}; s.dispatchEvent(new Event('change'));
    for(let i=0;i<120&&(!MODEL||MODEL.id!==${JSON.stringify(f.ac)});i++) await wait(250);
    $('nav').value=${JSON.stringify(f.nav)}; $('dep').value=${JSON.stringify(f.dep)}; $('arr').value=${JSON.stringify(f.arr)};
    $('alt').value=${JSON.stringify(alt)}; $('etd').value=${JSON.stringify(etd)};
    window.LAST_X=null; $('err').textContent=''; $('go').click();
    for(let i=0;i<1200&&!window.LAST_X&&!$('err').textContent;i++) await wait(250);
    for(let i=0;i<120&&$('go').disabled;i++) await wait(250);
    return $('err').textContent; })()`);
}
