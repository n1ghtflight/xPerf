// Named UI checks for the redesign, run against replayed test flights (deterministic).
//   node tools/ui_check.mjs [--only name,name] [--mode server|packs] [--port 8770]
// Needs: python server.py 8770, and fixtures from `node tools/regress.mjs record`.
import { spawnSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launch, replay, planFlight, FLIGHTS, inFlight, paused, lastPage } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const port = +(opt("port") || 8770), mode = opt("mode") || "server";
const only = opt("only") ? new Set(opt("only").split(",")) : null;
const checks = [];
export function check(name, fn) { checks.push({ name, fn }); }
function expect(cond, msg) { if (!cond) throw new Error(msg); }

// Open the app with replayed network data. flight: fixture to replay (default c172); plan: also plan it.
async function open(flightKey = "c172", { plan = false, width = 1440, height = 900, mobile = false, scheme = "dark" } = {}) {
  const page = await launch({ port, width, height, mobile, scheme, query: mode === "packs" ? "data=packs" : "" });
  await replay(page, join(here, "regress", "fixtures", `${mode}-${flightKey}.json`));
  await page.goto("/");
  const loaded = await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250));
    return document.getElementById('go').disabled ? document.getElementById('status').textContent : ""; })()`);
  if (page.loadFailures.length) { await page.close(); throw new Error("app files failed to load: " + page.loadFailures.join(", ")); }
  if (loaded) { await page.close(); throw new Error(`app data did not load in 60 s (status: ${loaded})`); }
  if (plan) { const err = await planFlight(page, FLIGHTS[flightKey]); expect(!err, `plan ${flightKey} failed: ${err}`); }
  return page;
}
// Resolve any CSS colour (lch/oklch/light-dark…) to "r,g,b" via a canvas pixel.
const RGB = `(c=>{const x=document.createElement('canvas').getContext('2d'); x.fillStyle='#000'; x.fillStyle=c; x.fillRect(0,0,1,1); return [...x.getImageData(0,0,1,1).data].slice(0,3).join(',');})`;

/* ---------------- checks ---------------- */

check("regress-safe", async () => {
  const r = spawnSync(process.execPath, [join(here, "regress.mjs"), "compare", "--port", String(port)], { encoding: "utf8" });
  expect(r.status === 0, "regression compare failed:\n" + (r.stdout || "").split("\n").filter(l => !l.startsWith("ok")).join("\n"));
});

check("theme", async () => {
  const page = await open();
  try {
    // read after two frames: the reduced-motion rule leaves .01ms transitions, which interpolate in oklab
    const bg = () => page.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(${RGB}(getComputedStyle(document.body).backgroundColor)))))`);
    expect(await bg() === "9,9,10", `dark OS: body background ${await bg()} ≠ 9,9,10`);
    await page.setScheme("light");
    expect(await bg() === "239,239,240", `light OS: body background ${await bg()} ≠ 239,239,240`);
    await page.setScheme("dark");
    await page.eval(`Shell.setTheme("light")`);
    expect(await bg() === "239,239,240", `Shell.setTheme("light") under dark OS: ${await bg()}`);
    expect(await page.eval(`Shell.theme()`) === "light", "Shell.theme() should report light");
    await page.eval(`Shell.setTheme("system")`);
    expect(await page.eval(`document.documentElement.hasAttribute("data-theme")`) === false, "system theme must remove data-theme");
  } finally { await page.close(); }
});

const VISIBLE_VIEWS = `[...document.querySelectorAll('.tabpanel')].filter(p=>!p.hidden&&p.getClientRects().length).map(p=>p.dataset.tab)`;
const settle = page => page.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);

check("views", async () => {
  const page = await open("c172", { plan: true });
  try {
    const views = await page.eval(`Shell.VIEWS.map(v=>v[0])`);
    expect(JSON.stringify(views) === JSON.stringify(["overview", "route", "airports", "takeoff", "profile", "fuel", "setup", "settings"]), "Shell.VIEWS ids: " + views);
    for (const id of views) {
      await page.click(`.sidebar [data-view="${id}"]`); await settle(page);
      const vis = await page.eval(VISIBLE_VIEWS);
      expect(vis.length === 1 && vis[0] === id, `sidebar ${id}: visible panels ${JSON.stringify(vis)}`);
    }
    const chords = { o: "overview", r: "route", a: "airports", t: "takeoff", p: "profile", f: "fuel", s: "setup", ",": "settings" };
    for (const [k, id] of Object.entries(chords)) {
      await page.eval(`document.activeElement?.blur()`);
      if (k !== ",") await page.key("g");
      await page.key(k); await settle(page);
      const vis = await page.eval(VISIBLE_VIEWS);
      expect(vis.length === 1 && vis[0] === id, `keys ${k === "," ? "," : "G " + k.toUpperCase()}: visible ${JSON.stringify(vis)}`);
    }
  } finally { await page.close(); }
});

check("view-memory", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click(`.sidebar [data-view="profile"]`);
    await page.goto("/");
    await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); })()`);
    const err = await planFlight(page, FLIGHTS.c172); expect(!err, err);
    await settle(page);
    const vis = await page.eval(VISIBLE_VIEWS);
    expect(vis.length === 1 && vis[0] === "profile", `after reload + plan: ${JSON.stringify(vis)}`);
  } finally { await page.close(); }
});

check("phone-tabbar", async () => {
  const page = await open("c172", { plan: true, width: 390, height: 844, mobile: true });
  try {
    const tabs = await page.eval(`[...document.querySelectorAll('.tabbar button')].filter(b=>b.getClientRects().length).map(b=>b.textContent.trim())`);
    expect(JSON.stringify(tabs) === JSON.stringify(["Overview", "Route", "Airports", "Profile", "More"]), "tab bar: " + JSON.stringify(tabs));
    const sidebarW = await page.eval(`document.querySelector('.sidebar').getBoundingClientRect().width`);
    expect(sidebarW < 1, "sidebar should be hidden on phones, width " + sidebarW);
    await page.click(`.tabbar [data-view="more"]`); await settle(page);
    const more = await page.eval(`[...document.querySelectorAll('.moresheet [data-view]')].filter(b=>b.getClientRects().length).map(b=>b.textContent.trim())`);
    expect(JSON.stringify(more) === JSON.stringify(["Takeoff & landing", "Fuel & levels", "FS2024 setup", "Settings"]), "More sheet: " + JSON.stringify(more));
  } finally { await page.close(); }
});

check("ipad-portrait", async () => {
  const page = await open("c172", { plan: true, width: 768, height: 1024, mobile: true });
  try {
    const w = () => page.eval(`document.querySelector('.sidebar').getBoundingClientRect().width`);
    expect(await w() <= 64, "portrait sidebar width " + await w());
    const labels = await page.eval(`[...document.querySelectorAll('.sidebar [data-view] .lbl')].filter(l=>l.getClientRects().length&&l.getBoundingClientRect().width>0).length`);
    expect(labels === 0, labels + " sidebar labels visible in icon mode");
    await page.click("#sbBtn"); await settle(page);
    expect(await w() >= 200, "after toggle sidebar width " + await w());
  } finally { await page.close(); }
});

// wait until no re-plan is running (body.replanning cleared and #go enabled), after a short grace period
const idle = page => page.eval(`(async()=>{ const w=ms=>new Promise(r=>setTimeout(r,ms)); await w(150);
  for(let i=0;i<1200&&(document.body.classList.contains('replanning')||document.getElementById('go').disabled);i++) await w(100); })()`);
const visible = (page, sel) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';})()`);
async function chipPick(page, chip, value) {
  await page.click(`[data-chip="${chip}"]`); await settle(page);
  await page.click(`.chipmenu [data-value="${value}"]`);
}

check("setup-first", async () => {
  const page = await open("c172");
  try {
    expect(await visible(page, "#surface .formcol"), "setup form should be visible in the surface before the first plan");
    const chips = await page.eval(`[...document.querySelectorAll('[data-chip]')].filter(e=>e.getClientRects().length).length`);
    expect(chips === 0, chips + " chips visible before the first plan");
    await page.eval(`(()=>{ const $=id=>document.getElementById(id); $('dep').value='KPAO'; $('arr').value='KTRK'; })()`);
    await page.click("#swapBtn");
    const swapped = await page.eval(`document.getElementById('dep').value+'/'+document.getElementById('arr').value`);
    expect(swapped === "KTRK/KPAO", "swap gave " + swapped);
    await page.click("#swapBtn");
    await page.eval(`(()=>{ document.getElementById('etd').value=${JSON.stringify("2026-10-20T12:00")}; document.activeElement?.blur(); })()`);
    await page.key("Enter", { ctrl: true });
    await page.eval(`(async()=>{ for(let i=0;i<600&&!window.LAST_X;i++) await new Promise(r=>setTimeout(r,100)); })()`);
    expect(await page.eval(`!!window.LAST_X`), "Ctrl+Enter did not plan");
  } finally { await page.close(); }
});

check("chips", async () => {
  const page = await open("c172", { plan: true });
  try {
    expect(await visible(page, '[data-chip="rules"]'), "rules chip not visible after planning");
    await page.eval(`window._x0=window.LAST_X`);
    await chipPick(page, "rules", "ifr"); await idle(page);
    expect(await page.eval(`document.getElementById('rules').value`) === "ifr", "rules not set to ifr");
    expect(await page.eval(`window.LAST_X&&window.LAST_X!==window._x0`), "no re-plan after picking IFR");
    expect(!(await page.eval(`document.body.classList.contains('replanning')`)), "replanning state not cleared");
  } finally { await page.close(); }
});

check("chips-race", async () => {
  const page = await open("c172", { plan: true });
  try {
    const ft0 = await page.eval(`LAST_X.sel.ft`);
    expect(await page.eval(`document.getElementById('rules').value`) === "vfr", "C172 default rules should be VFR");
    await chipPick(page, "rules", "ifr");
    await chipPick(page, "rules", "vfr");
    await idle(page);
    expect(await page.eval(`document.getElementById('rules').value`) === "vfr", "final rules not vfr");
    const ft = await page.eval(`LAST_X.sel.ft`);
    expect(ft === ft0, `final cruise ${ft} ≠ VFR plan ${ft0}`);
    expect(await page.eval(`document.querySelector('.tabpanel[data-tab="overview"]').textContent.includes(lvl(LAST_X.sel.ft))`), "overview does not show the final cruise level");
  } finally { await page.close(); }
});

check("replan-error", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('[data-chip="route"]'); await settle(page);
    await page.eval(`document.getElementById('chipArr').value='ZZZZ'`);
    await page.click("#chipRouteGo"); await idle(page);
    const err = await page.eval(`document.getElementById('err').textContent`);
    expect(/Enter valid airport codes/.test(err), "error text: " + err);
    expect(await visible(page, "#err"), "#err is not visible");
    expect(await page.eval(`document.querySelector('.tabpanel[data-tab="overview"]')?.children.length>0`), "previous results were cleared");
  } finally { await page.close(); }
});

check("all-settings", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('[data-chip="all"]'); await settle(page);
    expect(await visible(page, "#allSettings"), "All settings drawer not visible");
    const missing = await page.eval(`["ac","dep","arr","nav","alt","etd","load","extra","rules","opt","fl","oxy","go"].filter(id=>!document.querySelector('#allSettings #'+id))`);
    expect(!missing.length, "drawer lacks: " + missing.join(", "));
  } finally { await page.close(); }
});

const TILES = ["map", "cruise", "time-distance", "fuel", "wind", "profile", "dep-wx", "arr-wx"];

check("overview", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('.sidebar [data-view="overview"]'); await settle(page);
    const tiles = await page.eval(`[...document.querySelectorAll('.tabpanel[data-tab="overview"] [data-tile]')].map(t=>t.dataset.tile)`);
    for (const t of TILES) expect(tiles.includes(t), `missing tile ${t} (have ${tiles.join(",")})`);
    await page.click('[data-tile="map"]'); await settle(page);
    const vis = await page.eval(VISIBLE_VIEWS);
    expect(vis.length === 1 && vis[0] === "route", "map tile opened " + JSON.stringify(vis));
  } finally { await page.close(); }
});

check("overview-values", async () => {
  const page = await open("c172", { plan: true });
  try {
    const r = await page.eval(`(()=>{ const t=n=>document.querySelector('[data-tile="'+n+'"]')?.textContent||'';
      return { cruise:t('cruise').includes(lvl(LAST_X.sel.ft)), time:t('time-distance').includes(hhmm(LAST_X.sel.time)),
        dist:t('time-distance').includes(String(Math.round(nm(LAST_X.total)))),
        count:+(document.querySelector('[data-callout]')?.dataset.count??-1), warnings:planWarnings(LAST_X).length }; })()`);
    expect(r.cruise, "cruise tile lacks the cruise level");
    expect(r.time, "time tile lacks the flight time");
    expect(r.dist, "distance tile lacks the distance");
    expect(r.count === r.warnings, `callout count ${r.count} ≠ ${r.warnings} warnings`);
  } finally { await page.close(); }
});

check("airports-list", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('.sidebar [data-view="airports"]'); await settle(page);
    expect(await visible(page, '[data-apt="dep"]') && await visible(page, '[data-apt="arr"]'), "airport list rows missing");
    const aria = await page.eval(`(()=>{ const l=document.querySelector('.aptlist'), rows=[...l.querySelectorAll('.aptrow')];
      return { role:l.getAttribute('role'), sel:rows.filter(r=>r.hasAttribute('aria-selected')).length, cur:rows.filter(r=>r.getAttribute('aria-current')==='true').map(r=>r.dataset.apt) }; })()`);
    expect(aria.role !== "listbox" && !aria.sel, "airport rows use listbox semantics: " + JSON.stringify(aria));
    expect(JSON.stringify(aria.cur) === '["dep"]', "aria-current on: " + JSON.stringify(aria.cur));
    await page.click('[data-apt="arr"]'); await settle(page);
    expect(await page.eval(`[...document.querySelectorAll('.aptrow[aria-current="true"]')].map(r=>r.dataset.apt).join()`) === "arr", "aria-current did not move to the arrival");
    const shown = await page.eval(`[...document.querySelectorAll('.aptdetail [data-detail]')].filter(e=>e.getClientRects().length).map(e=>e.dataset.detail)`);
    expect(JSON.stringify(shown) === '["arr"]', "detail shown: " + JSON.stringify(shown));
    expect(await page.eval(`document.querySelector('.aptdetail [data-detail="arr"]').textContent.includes('KTRK')`), "arrival card lacks KTRK");
  } finally { await page.close(); }
});

check("feature-inventory", async () => {
  for (const f of Object.keys(FLIGHTS)) {
    const page = await open(f, { plan: true });
    try {
      const base = JSON.parse(readFileSync(join(here, "regress", "baseline", `${mode}-${f}.json`), "utf8")).inventory || [];
      const missing = await page.eval(`(${JSON.stringify(base)}).filter(h=>!document.querySelector(h))`);
      expect(!missing.length, `${f}: hooks gone: ${missing.join(", ")}`);
    } finally { await page.close(); }
  }
});

check("theme-follow", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('.sidebar [data-view="profile"]'); await settle(page);
    const stroke = () => page.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{ const e=document.querySelector('.c-axis'); r(e&&document.querySelector('.c-profile')?${RGB}(getComputedStyle(e).fill):null); })))`);
    // the accent is the same in both themes by design, so check a theme-dependent chart colour (axis text)
    const dark = await stroke(); expect(dark, "profile chart lacks .c-profile / .c-axis");
    await page.eval(`Shell.setTheme("light")`);
    const light = await stroke();
    expect(dark !== light, `chart axis colour did not change with the theme (${dark})`);
  } finally { await page.close(); }
});

check("no-hex", async () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const files = { "charts.js": strip(readFileSync(join(here, "..", "charts.js"), "utf8")), "nav.js": strip(readFileSync(join(here, "..", "nav.js"), "utf8")),
    "blueprint.js": strip(readFileSync(join(here, "..", "blueprint.js"), "utf8")) };
  const html = readFileSync(join(here, "..", "index.html"), "utf8"), a = html.indexOf("function profileSVG"), b = html.indexOf("\n}\n", a);
  files["profileSVG"] = html.slice(a, b);
  const bad = Object.entries(files).map(([n, s]) => [n, [...new Set(s.match(/#[0-9a-fA-F]{3,8}\b/g) || [])].filter(h => !/^#(fff|ffffff)$/i.test(h))]).filter(([, h]) => h.length);
  expect(!bad.length, "hard-coded colours: " + bad.map(([n, h]) => `${n}: ${h.join(" ")}`).join(" | "));
});

check("no-alias-colours", async () => {
  const files = ["index.html", "nav.js", "charts.js", "styles/app.css", "styles/tokens.css"];
  const bad = files.map(f => [f, [...new Set(readFileSync(join(here, "..", f), "utf8").match(/--(panel2|muted|green|amber|red|magenta)\b/g) || [])]]).filter(([, m]) => m.length);
  expect(!bad.length, "old colour aliases: " + bad.map(([f, m]) => `${f}: ${m.join(" ")}`).join(" | "));
});

check("palette", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`document.activeElement?.blur()`);
    await page.key("k", { ctrl: true }); await settle(page);
    expect(await visible(page, "#palette"), "Ctrl+K did not open the palette");
    expect(await page.eval(`document.activeElement?.id`) === "pInput", "palette input not focused");
    const first = await page.eval(`document.querySelector('#pList .p-group')?.textContent`);
    expect(first === "This plan", "first group: " + first);
    await page.key("Escape"); await settle(page);
    expect(!(await visible(page, "#palette")), "Esc did not close the palette");
    // palette opened over the All settings drawer: one Esc closes the palette only
    await page.click('[data-chip="all"]'); await settle(page);
    await page.key("k", { ctrl: true }); await settle(page);
    await page.key("Escape"); await settle(page);
    expect(!(await visible(page, "#palette")), "Esc did not close the palette over the drawer");
    expect(await visible(page, "#allSettings"), "one Esc also closed the drawer under the palette");
  } finally { await page.close(); }
});

check("typed-plan", async () => {
  const page = await open("b789");
  try {
    await page.eval(`document.getElementById('etd').value=${JSON.stringify("2026-10-20T12:00")}; document.getElementById('nav').value='awy'; document.activeElement?.blur()`);
    await page.key("k", { ctrl: true }); await settle(page);
    await page.type("#pInput", "KJFK EGLL B789"); await settle(page);
    const row = await page.eval(`document.querySelector('#pList .p-item[aria-selected="true"]')?.textContent||''`);
    expect(/Plan KJFK → EGLL in B789/.test(row), "selected row: " + row);
    await page.key("Enter");
    await page.eval(`(async()=>{ for(let i=0;i<1200&&!(window.LAST_X&&LAST_X.dep.icao==='KJFK');i++) await new Promise(r=>setTimeout(r,100)); })()`);
    await idle(page);
    expect(await page.eval(`window.LAST_X?.dep.icao`) === "KJFK", "typed plan did not plan KJFK");
    expect(await page.eval(`MODEL.id`) === "oap:b789", "aircraft not switched: " + await page.eval(`MODEL.id`));
    expect(await page.eval(`localStorage.getItem("xperf.ac")`) === "oap:b789", "typed plan did not remember the aircraft");
    expect(/B789/.test(await page.eval(`document.getElementById("acSearch")?.value||""`)), "aircraft picker still shows the old type");
  } finally { await page.close(); }
});

check("keys-in-inputs", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('.sidebar [data-view="overview"]'); await settle(page);
    await page.click('[data-chip="route"]'); await settle(page);
    await page.type("#chipDep", "gr"); await settle(page);
    let vis = await page.eval(VISIBLE_VIEWS);
    expect(vis[0] === "overview", "typing g r in an input switched view to " + vis);
    await page.key("Escape");
    await page.key("k", { ctrl: true }); await settle(page);
    await page.type("#pInput", "gr"); await settle(page);
    vis = await page.eval(VISIBLE_VIEWS);
    expect(vis[0] === "overview", "typing g r in the palette switched view to " + vis);
    expect(await page.eval(`document.getElementById('pInput').value`) === "gr", "palette input did not receive the keys");
  } finally { await page.close(); }
});

check("touch-tooltips", async () => {
  const page = await open("c172", { plan: true, width: 390, height: 844, mobile: true });
  try {
    await page.eval(`Shell.showView("fuel")`); await settle(page);
    const target = `[data-tab="fuel"] svg circle`;
    expect(await page.eval(`!!document.querySelector('${target}')?.querySelector('title')`), "level chart dot has no <title>");
    await page.tap(target); await settle(page);
    const tip = await page.eval(`(()=>{const t=document.querySelector('.tip.sticky'); return t&&!t.hidden&&t.getClientRects().length?t.textContent:null;})()`);
    expect(tip && /ft|FL/.test(tip), "no sticky tooltip after tapping a level dot (got " + tip + ")");
    await page.tap(20, 200); await settle(page);
    expect(await page.eval(`!document.querySelector('.tip.sticky:not([hidden])')`), "tooltip did not close on tapping elsewhere");
    expect(await page.eval(`!/\\bhover\\b/i.test(document.querySelector('#results').innerText)`), "touch copy still says 'hover'");
  } finally { await page.close(); }
});

check("overflow", async () => {
  const sizes = [[1440, 900, false], [1024, 768, false], [768, 1024, true], [390, 844, true]];
  const bad = [];
  for (const scheme of ["dark", "light"]) for (const [w, h, mob] of sizes) {
    const page = await open("b789", { plan: true, width: w, height: h, mobile: mob, scheme });
    try {
      for (const v of ["overview", "route", "airports", "takeoff", "profile", "fuel", "setup", "settings"]) {
        await page.eval(`Shell.showView(${JSON.stringify(v)})`); await settle(page);
        const o = await page.eval(`({doc:document.documentElement.scrollWidth-innerWidth, surf:(s=>s.scrollWidth-s.clientWidth)(document.getElementById('surface'))})`);
        if (o.doc > 1 || o.surf > 1) bad.push(`${w}x${h} ${scheme} ${v}: page +${o.doc}px, surface +${o.surf}px`);
      }
    } finally { await page.close(); }
  }
  expect(!bad.length, "horizontal overflow:\n    " + bad.join("\n    "));
});

const SIM_ONLY = "For flight simulation only — not for real-world navigation.";

check("settings", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`document.activeElement?.blur()`); await page.key(","); await settle(page);
    const vis = await page.eval(VISIBLE_VIEWS);
    expect(vis[0] === "settings", ", opened " + vis);
    await page.eval(`(()=>{ const s=document.getElementById('themeSel'); s.value='light'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    expect(await page.eval(`document.documentElement.dataset.theme`) === "light", "theme control did not set data-theme");
    const txt = await page.eval(`document.querySelector('.settingspanel').innerText`);
    expect(txt.includes(SIM_ONLY), "settings lacks the simulation-only line");
    expect(/Data sources and model assumptions/.test(txt), "settings lacks data sources and assumptions");
    expect(/Ctrl\s*K/i.test(txt) && /G\s*O/.test(txt), "settings lacks the keyboard shortcut list");
  } finally { await page.close(); }
});

check("first-visit", async () => {
  const page = await open("c172");
  try {
    expect(await page.eval(`document.querySelector('#surface .formcol').innerText.includes(${JSON.stringify(SIM_ONLY)})`), "setup form lacks the simulation-only line");
  } finally { await page.close(); }
});

/* ---------- final-review fixes (each written to fail first) ---------- */
// editing the aircraft of a planned flight: search box on top and focused, a long list below it, no outer scroll
check("ac-chip-layout", async () => {
  const page = await open("b789", { plan: true, height: 800 });
  try {
    await page.click('[data-chip="ac"]'); await settle(page);
    const r = await page.eval(`(()=>{ const m=document.getElementById('chipMenu'), i=document.getElementById('acSearch'), l=document.getElementById('acList');
      const mr=m.getBoundingClientRect(), ir=i.getBoundingClientRect(), lr=l.getBoundingClientRect();
      return { focused:document.activeElement===i, menuScroll:m.scrollTop, inputIn:ir.top>=mr.top&&ir.bottom<=mr.bottom,
        listShown:!l.hidden, listH:Math.round(lr.height), listInMenu:lr.bottom<=mr.bottom+1, onScreen:lr.bottom<=innerHeight,
        cur:(()=>{ const c=l.querySelector('.cur'); if(!c) return false; const cr=c.getBoundingClientRect(); return cr.top>=lr.top&&cr.bottom<=lr.bottom; })() }; })()`);
    expect(r.focused, "search box not focused");
    expect(/B789/.test(await page.eval(`document.getElementById('acSearch').value`)), "search box does not show the planned aircraft");
    expect(r.menuScroll === 0 && r.inputIn, "search box scrolled out of the menu: " + JSON.stringify(r));
    expect(r.listShown && r.listH >= 300, "aircraft list too short: " + JSON.stringify(r));
    expect(r.listInMenu && r.onScreen, "aircraft list spills out of the menu or the window: " + JSON.stringify(r));
    expect(r.cur, "current aircraft not scrolled into view in the list");
  } finally { await page.close(); }
});

check("ac-chip", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('[data-chip="ac"]'); await settle(page);
    await page.type("#acSearch", "SR22"); await settle(page);
    await page.key("Enter"); await idle(page);
    expect(await page.eval(`String(LAST_X.m.code).toUpperCase()`) === "SR22", "aircraft chip did not re-plan with SR22: " + await page.eval(`LAST_X.m.code`));
    expect(await page.eval(`document.getElementById('chipMenu').hidden`), "aircraft menu stayed open");
    expect(/SR22/.test(await page.eval(`document.querySelector('[data-chip="ac"]').textContent`)), "ac chip does not show SR22");
  } finally { await page.close(); }
});

check("menu-then-palette", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('[data-chip="nav"]'); await settle(page);
    await page.key("k", { ctrl: true }); await settle(page);
    await page.type("#pInput", "d"); await settle(page);
    expect(await page.eval(`document.getElementById('pInput').value`) === "d", "palette input did not get the letter");
    expect(await page.eval(`document.getElementById('chipMenu').hidden`), "chip menu still open behind the palette");
    expect(!(await page.eval(`document.body.classList.contains('replanning')`)), "a re-plan was triggered by typing");
  } finally { await page.close(); }
});

check("pubsel-replan", async () => {
  const page = await open("c172", { plan: true });
  try {
    const r = await page.eval(`(()=>{ let rp=0, calc=0; const oR=Chips.replan, oC=window.calculate;
      Chips.replan=()=>{ rp++; return Promise.resolve(); }; window.calculate=()=>{ calc++; return Promise.resolve(); };
      const s=document.createElement('select'); s.id='pubSel'; s.dataset.key='KPAO-KTRK'; s.innerHTML='<option value="0">r</option>'; document.body.appendChild(s);
      s.dispatchEvent(new Event('change',{bubbles:true})); s.remove(); Chips.replan=oR; window.calculate=oC; return {rp,calc}; })()`);
    expect(r.rp === 1 && r.calc === 0, `published-route change: replan ${r.rp}×, direct calculate ${r.calc}×`);
  } finally { await page.close(); }
});

check("chips-after-error", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.click('[data-chip="route"]'); await settle(page);
    await page.eval(`document.getElementById('chipArr').value='ZZZZ'`);
    await page.click("#chipRouteGo"); await idle(page);
    const chip = await page.eval(`(()=>{const c=document.querySelector('[data-chip="route"]'); return {t:c.textContent, bad:c.classList.contains('bad')};})()`);
    expect(/ZZZZ/.test(chip.t) && chip.bad, "route chip after a failed plan: " + JSON.stringify(chip));
  } finally { await page.close(); }
});

check("palette-click", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`document.activeElement?.blur()`); await page.key("k", { ctrl: true }); await settle(page);
    await page.type("#pInput", "Navigation"); await settle(page);
    await page.click("#pList .p-item"); await settle(page);
    expect(!(await page.eval(`document.getElementById('chipMenu').hidden`)), "clicking 'Navigation…' did not open the menu");
  } finally { await page.close(); }
});

check("e-export", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`window._pln=0; window.downloadPLN=()=>{ window._pln++; }; document.activeElement?.blur()`);
    await page.key("e"); await settle(page);
    expect(await page.eval(`window._pln`) === 1, "E did not export the .PLN");
    await page.click('[data-chip="route"]'); await settle(page);   // a visible text field (the drawer's are hidden)
    await page.eval(`document.getElementById('chipDep').focus()`); await page.key("e"); await settle(page);
    expect(await page.eval(`window._pln`) === 1, "E exported while typing in a field");
  } finally { await page.close(); }
});

check("drawer-error-phone", async () => {
  const page = await open("c172", { plan: true, width: 390, height: 844, mobile: true });
  try {
    await page.click('[data-chip="all"]'); await settle(page);
    await page.eval(`document.getElementById('arr').value='ZZZZ'`);
    await page.click("#allSettings #go"); await idle(page);
    expect(await visible(page, "#err"), "plan error hidden on phone");
    expect(await page.eval(`document.getElementById('allSettings').hidden`), "full-screen drawer still covers the error");
  } finally { await page.close(); }
});

/* ---------------- your own route: pasted text / SimBrief OFP ---------------- */
const ROUTE = "KPAO OAK V195 ILA V200 RANGO KTRK";
const waitPlan = (page, cond) => page.eval(`(async()=>{ for(let i=0;i<1200&&!(${cond})&&!document.getElementById('err').textContent;i++) await new Promise(r=>setTimeout(r,100)); return document.getElementById('err').textContent; })()`);

check("route-paste", async () => {
  const page = await open("c172");
  try {
    await page.eval(`(async()=>{ const $=id=>document.getElementById(id); $('ac').value='apm:C172'; $('ac').dispatchEvent(new Event('change'));
      for(let i=0;i<120&&(!MODEL||MODEL.id!=='apm:C172');i++) await new Promise(r=>setTimeout(r,250));
      $('etd').value='2026-10-20T12:00'; $('dep').value=''; $('arr').value=''; })()`);
    await page.click('.seg[data-for="nav"] [data-seg="import"]'); await settle(page);
    expect(await visible(page, "#route"), "route box not shown for Your route");
    await page.type("#route", ROUTE);
    await page.eval(`document.getElementById('route').dispatchEvent(new Event('change',{bubbles:true}))`);
    expect(await page.eval(`document.getElementById('dep').value+'-'+document.getElementById('arr').value`) === "KPAO-KTRK", "route ends did not set From / To");
    await page.click("#go"); const err = await waitPlan(page, "window.LAST_X"); await idle(page);
    expect(!err, "plan failed: " + err);
    const r = await page.eval(`({mode:LAST_X.navMode, pts:LAST_X.route.points.map(p=>p.label).join(' '), awy:LAST_X.route.plan.legs.map(l=>l&&l.awy).join(' '), note:LAST_X.navNote, title:document.querySelector('#results h2')?.textContent||''})`);
    expect(r.mode === "import", "mode " + r.mode);
    expect(r.pts === "KPAO OAK BERKS SABLO CROIT CORDD RAGGS BESSA ELEGY ZAKUL ILA YUBBA RAILE MRGGO RANGO KTRK", "points: " + r.pts);
    expect(/V195/.test(r.awy) && /V200/.test(r.awy), "airway legs: " + r.awy);
    expect(!r.note, "unexpected note: " + r.note);
    expect(/Your route/.test(await page.eval(`document.querySelector('[data-chip="nav"]').textContent`)), "nav chip label");
  } finally { await page.close(); }
});

check("route-simbrief", async () => {
  const xml = readFileSync(join(here, "..", "tests", "fixtures", "simbrief-UNTT-UNEE.xml"), "utf8");
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`XD.simbrief=async u=>{ window.SB_ASKED=u; return ${JSON.stringify(xml)}; }`);
    await page.click('[data-chip="nav"]'); await settle(page);
    await page.click('#chipMenu [data-value="import"]'); await settle(page);
    expect(await visible(page, "#allSettings"), "empty Your route did not open All settings");
    expect(await page.eval(`document.activeElement?.id`) === "route", "route box not focused");
    await page.eval(`window.LAST_X=null; document.getElementById('sbSrc').value='xperf_pilot'`);
    await page.click("#sbFetch"); const err = await waitPlan(page, "window.LAST_X&&LAST_X.dep.icao==='UNTT'"); await idle(page);
    expect(!err, "plan failed: " + err);
    const r = await page.eval(`({asked:window.SB_ASKED, mode:LAST_X.navMode, dep:LAST_X.dep.icao, arr:LAST_X.arr.icao, pts:LAST_X.route.points.map(p=>p.label).join(' '),
      chip:document.querySelector('[data-chip="nav"]').textContent, hint:document.getElementById('routeHint').textContent, ac:MODEL.id})`);
    expect(r.asked === "xperf_pilot", "XD.simbrief got " + r.asked);
    expect(r.mode === "import" && r.dep === "UNTT" && r.arr === "UNEE", `planned ${r.mode} ${r.dep}-${r.arr}`);
    expect(r.pts === "UNTT DER21 D152Z NALED D029G D042E CF23 UNEE", "points: " + r.pts);
    expect(/SimBrief/.test(r.chip), "nav chip: " + r.chip);
    expect(/PA24 isn't in XPerf/.test(r.hint) && r.ac === "apm:C172", "aircraft fallback: " + r.hint);
    const pln = await page.eval(`buildPLN(LAST_X).then(x=>typeof x==='string'?x:x.xml||JSON.stringify(x))`);
    expect(/<ICAOIdent>D029G<\/ICAOIdent>/.test(pln) && /<ICAORegion>UN<\/ICAORegion>[\s\S]*?<ICAOIdent>D029G/.test(pln), "PLN lacks SimBrief region for D029G");
  } finally { await page.close(); }
});

check("route-palette", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.key("k", { ctrl: true }); await settle(page);
    await page.type("#pInput", ROUTE); await settle(page);
    const row = await page.eval(`document.querySelector('#pList .p-item[aria-selected="true"]')?.textContent||''`);
    expect(/Fly route KPAO → KTRK via OAK V195 ILA V200 RANGO/.test(row), "selected row: " + row);
    await page.eval(`window.LAST_X=null`); await page.key("Enter");
    const err = await waitPlan(page, "window.LAST_X"); await idle(page);
    expect(!err, "plan failed: " + err);
    expect(await page.eval(`LAST_X.navMode+' '+LAST_X.route.points.length`) === "import 16", "palette route not planned as imported");
  } finally { await page.close(); }
});

// start screen: a banner on top with one-click example flights; gone once planned
check("start-hero", async () => {
  const page = await open("c172", { width: 1100 });
  try {
    expect(await visible(page, "#hero"), "no start banner");
    const r = await page.eval(`(()=>{ const h=document.getElementById('hero'), f=document.querySelector('.work .setupform');
      return { above:h.getBoundingClientRect().bottom<=f.getBoundingClientRect().top, ex:[...h.querySelectorAll('[data-example]')].map(b=>b.dataset.example),
        text:h.textContent.replace(/\s+/g,' '), formTitle:!!f.querySelector('.viewtitle')?.getClientRects().length }; })()`);
    expect(r.above, "banner is not above the setup form");
    expect(JSON.stringify(r.ex) === '["c172","sr22","a320","b789"]', "examples: " + JSON.stringify(r.ex));
    expect(/Plan flight/.test(r.text) && /KPAO → KTRK/.test(r.text), "banner text: " + r.text);
    expect(!r.formTitle, "setup form repeats the Plan a flight title under the banner");
    await page.click('[data-example="c172"]');
    await page.eval(`(async()=>{ for(let i=0;i<600&&!(window.LAST_X&&LAST_X.arr.icao==='KTRK');i++) await new Promise(r=>setTimeout(r,100)); })()`);
    await idle(page);
    const p = await page.eval(`({dep:LAST_X?.dep.icao, arr:LAST_X?.arr.icao, ac:MODEL.id, nav:document.getElementById('nav').value, planned:document.body.classList.contains('planned')})`);
    expect(p.dep === "KPAO" && p.arr === "KTRK" && p.ac === "apm:C172" && p.nav === "direct" && p.planned, "example did not plan: " + JSON.stringify(p));
    expect(!(await visible(page, "#hero")), "banner still shown after planning");
  } finally { await page.close(); }
});

check("start-hero-phone", async () => {
  const page = await open("c172", { width: 390, height: 800, mobile: true });
  try {
    const r = await page.eval(`(()=>{ const h=document.getElementById('hero'), b=[...h.querySelectorAll('[data-example]')].map(x=>x.getBoundingClientRect());
      return { overflow:document.documentElement.scrollWidth>innerWidth, cols:new Set(b.map(x=>Math.round(x.left))).size, art:!!h.querySelector('svg')?.getClientRects().length }; })()`);
    expect(!r.overflow && r.cols === 2 && !r.art, "phone banner: " + JSON.stringify(r));
  } finally { await page.close(); }
});

check("new-flight", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`(()=>{ const $=id=>document.getElementById(id); $('alt').value='KSFO'; $('route').value='KPAO OAK KTRK'; $('nav').value='import'; })()`);
    await page.click('[data-chip="new"]'); await settle(page);
    const s = await page.eval(`(()=>{ const $=id=>document.getElementById(id);
      return {planned:document.body.classList.contains('planned'), bar:$('chipbar').hidden, fields:['dep','arr','alt','etd','route'].map(i=>$(i).value).join(''),
        empty:!$('results').children.length&&!!$('hero')&&$('hero').getClientRects().length>0, crumb:$('crumb').textContent, formHome:!!document.querySelector('.work > .formcol'),
        errHome:$('go').nextElementSibling===$('err'), ac:$('ac').value, x:window.LAST_X, nav:$('nav').value, view:Shell.current()}; })()`);
    expect(!s.planned && s.bar, "still in the planned layout");
    expect(s.fields === "", "fields not cleared: " + s.fields);
    expect(s.empty && s.crumb === "New flight", "results / title not reset");
    expect(s.formHome && s.errHome, "form or error line not back in place");
    expect(s.ac === "apm:C172" && s.nav === "import" && s.x === null && s.view === "overview", `kept/cleared wrong: ${JSON.stringify(s)}`);
    expect(await visible(page, "#dep"), "From field not visible");
    await page.eval(`document.getElementById('nav').value='direct'`);
    const err = await planFlight(page, FLIGHTS.c172); expect(!err, "re-plan failed: " + err);
    expect(await page.eval(`document.body.classList.contains('planned')&&!!document.querySelector('#drawerBody > .formcol')`), "second plan did not move the form to All settings");
    await page.key("k", { ctrl: true }); await settle(page); await page.type("#pInput", "new flight"); await settle(page);
    expect(/New flight/.test(await page.eval(`document.querySelector('#pList .p-item[aria-selected="true"]')?.textContent||''`)), "no New flight command in the palette");
  } finally { await page.close(); }
});

// the aircraft blueprint: on the Overview aircraft tile and the Aircraft data card, never under the tile's text,
// and hidden by the Settings switch
const BP_GEOM = `(()=>{ const t=document.querySelector('.actile'), c=t&&t.querySelector('.actxt'), w=t&&t.querySelector('.actile .bp-wing');
  if(!t||!c||!w) return null; const a=c.getBoundingClientRect(), b=w.getBoundingClientRect(), s=t.getBoundingClientRect();
  const overlap=a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
  return {overlap, text:[a.left,a.top,a.right,a.bottom].map(Math.round), wing:[b.left,b.top,b.right,b.bottom].map(Math.round), wingInTile:b.right>s.left&&b.left<s.right&&b.bottom>s.top&&b.top<s.bottom, span:t.querySelector('.bp')?.textContent||''}; })()`;
check("blueprint", async () => {
  for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
    const page = await open("c172", { plan: true, width: w, height: h, mobile });
    try {
      await page.eval(`Shell.showView('overview')`); await settle(page);
      const g = await page.eval(BP_GEOM);
      expect(g, `no aircraft tile with a blueprint at ${w}px`);
      expect(/11\.00 m/.test(g.span), "wingspan label missing: " + g.span);
      expect(g.wingInTile && !g.overlap, `drawing under the text at ${w}px: text ${g.text}, wing ${g.wing}`);
      if (w > 1000) {
        expect(await page.eval(`!!document.querySelector('#acCard .bp')`), "no blueprint on the Aircraft data card");
        await page.eval(`Shell.showView('settings')`); await settle(page);
        await page.click("#bpTgl"); await settle(page);
        expect(await page.eval(`document.body.classList.contains('no-blueprint')&&localStorage.getItem('xperf.blueprint')==='0'`), "switch did not turn the drawing off");
        await page.eval(`Shell.showView('overview')`); await settle(page);
        expect(!(await visible(page, ".actile .bp")), "drawing still visible after switching it off");
        await page.click("#bpTgl"); await settle(page);
      }
    } finally { await page.close(); }
  }
});

// clicks inside the work surface must reach their controls (the surface records the current view as data-view)
check("surface-clicks", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`Shell.showView('profile')`); await settle(page);
    const before = await page.eval(`document.getElementById('windTgl')?.checked`);
    expect(typeof before === "boolean", "no winds checkbox on the profile");
    await page.click("#windTgl"); await settle(page);
    expect(await page.eval(`document.getElementById('windTgl').checked`) === !before, "checkbox click was cancelled");
    expect(await page.eval(`!document.getElementById('surface').hasAttribute('aria-current')`), "surface marked as the current page link");
  } finally { await page.close(); }
});

// web release: no EUROCONTROL data or lookups ship (the GA table replaces them)
check("no-eurocontrol", async () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");
  const bad = [];
  for (const f of ["index.html", "data.js", "acpicker.js", "nav.js", "overview.js", "chips.js", "shell.js", "pln.js"]) {
    const hits = strip(readFileSync(join(here, "..", f), "utf8")).match(/eurocontrol|apm_snapshot|\/api\/apm/gi);
    if (hits) bad.push(`${f}: ${hits.length}`);
  }
  if (/\/api\/apm|APM_URL/.test(readFileSync(join(here, "..", "server.py"), "utf8"))) bad.push("server.py: /api/apm");
  expect(!bad.length, "EUROCONTROL still referenced: " + bad.join(", "));
  const page = await open("c172");
  try {
    expect(await page.eval(`![...document.getElementById('ac').options].some(o=>o.value==='other')`), "Other ICAO type option still listed");
    await page.eval(`(()=>{ const i=document.querySelector('.acpick input'); i.focus(); i.value='ZZ9Q'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`); await settle(page);
    expect(await page.eval(`!document.querySelector('.acopt.lookup')`), "picker still offers a lookup for unlisted types");
  } finally { await page.close(); }
});

// the hosted build: a plain static server (no XPerf API) serves tools/build_site.py's output; the app runs on the
// packs, and once visited it opens and plans with the site's server gone (service worker cache)
check("static-site", async () => {
  if (mode !== "server") return;                       // builds and serves its own copy; once per run is enough
  const out = join(here, "..", "out", "site-check"), sport = 8779;
  const b = spawnSync("python", [join(here, "build_site.py"), "--out", out], { encoding: "utf8" });
  expect(b.status === 0, "build_site failed: " + (b.stderr || b.stdout));
  let srv = spawn("python", ["-m", "http.server", String(sport), "--bind", "127.0.0.1", "--directory", out], { stdio: "ignore" });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${sport}/index.html`)).ok) break; } catch {} await wait(250); }
  const page = await launch({ port: sport });
  try {
    await page.goto("/");
    await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); })()`);
    expect(await page.eval(`XD.mode`) === "packs", "static site is not in packs mode");
    let err = await planFlight(page, FLIGHTS.c172); expect(!err, "plan on the static site failed: " + err);
    await page.eval(`navigator.serviceWorker.ready.then(()=>true)`);
    await page.goto("/");                                 // second visit: the worker controls the page and caches packs
    await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); })()`);
    expect(await page.eval(`!!navigator.serviceWorker.controller`), "service worker not controlling the page");
    err = await planFlight(page, FLIGHTS.c172); expect(!err, "second plan failed: " + err);
    srv.kill(); srv = null; await wait(500);
    let down = false; try { await fetch(`http://127.0.0.1:${sport}/index.html`); } catch { down = true; }
    expect(down, "the static server is still answering: the offline step would prove nothing");
    await page.goto("/");
    await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); })()`);
    expect(await page.eval(`!!document.getElementById('go')&&typeof XD==='object'`), "app did not open with the site offline");
    err = await planFlight(page, FLIGHTS.c172); expect(!err, "offline plan failed: " + err);
  } finally { await page.close(); if (srv) srv.kill(); }
});

// a public site credits its data sources (Open-Meteo requires attribution) and says it is for simulation only
check("about-credits", async () => {
  const page = await open("c172");
  try {
    await page.eval(`Shell.showView('settings')`); await settle(page);
    const t = await page.eval(`document.getElementById('about')?.innerText||''`);
    for (const need of ["flight simulation only", "OurAirports", "FAA", "OpenAP", "Open-Meteo", "OpenStreetMap", "aviationweather.gov", "Leaflet", "not affiliated"])
      expect(t.toLowerCase().includes(need.toLowerCase()), `About is missing “${need}”`);
    expect(await page.eval(`!!document.querySelector('#about a[href^="https://open-meteo.com"]')`), "no Open-Meteo attribution link");
  } finally { await page.close(); }
});

// the route map fills the window below it (legend and nav-log line still on screen) and keeps the route in view
check("route-map-fill", async () => {
  const page = await open("c172", { plan: true, width: 1440, height: 1300 });
  try {
    await page.eval(`Shell.showView('route')`); await page.eval(`new Promise(r=>setTimeout(r,600))`);
    const g = () => page.eval(`(()=>{ const m=document.getElementById('map'), s=document.getElementById('surface'), d=document.querySelector('#detlog summary');
      const pts=LAST_X.route.points, b=MAP.getBounds();
      return {h:m.offsetHeight, gap:Math.round(s.getBoundingClientRect().bottom-d.getBoundingClientRect().bottom), inView:pts.every(p=>b.contains([p.lat,p.lon]))}; })()`);
    let r = await g();
    expect(r.h > 700, "map did not grow with a tall window: " + r.h + " px");
    expect(r.gap >= 0 && r.gap < 120, "map does not fill down to the bottom (nav-log line " + r.gap + " px above the edge)");
    expect(r.inView, "route not fully in view");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 760, deviceScaleFactor: 1, mobile: false });
    await page.eval(`window.dispatchEvent(new Event('resize')); new Promise(r=>setTimeout(r,500))`);
    r = await g();
    expect(r.h >= 380 && r.h < 600, "map did not shrink back on a short window: " + r.h + " px");
    expect(r.inView, "route not re-fitted after the resize");
  } finally { await page.close(); }
});

// a SID / STAR that adds nothing to draw is named on the map at its airport; a navaid on the airport keeps a readable label
check("route-procs", async () => {
  // live data (no replay): this route needs the A320 from OpenAP and KSFO / KSEA procedures from the server
  const page = await launch({ port, query: mode === "packs" ? "data=packs" : "" });
  await page.goto("/");
  await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); await window.NAV_READY; })()`);
  try {
    await page.eval(`(async()=>{ const $=id=>document.getElementById(id);
      $('ac').value='oap:a320'; $('ac').dispatchEvent(new Event('change')); for(let i=0;i<120&&(!MODEL||MODEL.id!=='oap:a320');i++) await new Promise(r=>setTimeout(r,250));
      $('etd').value='2026-10-20T12:00'; $('nav').value='import'; $('route').value='KSFO GAPP7 SFO DCT RBL DCT LMT HAWKZ8 KSEA';
      $('route').dispatchEvent(new Event('change',{bubbles:true})); window.LAST_X=null; $('go').click();
      for(let i=0;i<1200&&!window.LAST_X&&!$('err').textContent;i++) await new Promise(r=>setTimeout(r,100)); })()`);
    { const e = await page.eval(`document.getElementById("err").textContent`); expect(!e, "plan failed: " + e); }
    await page.eval(`Shell.showView('route')`); await page.eval(`new Promise(r=>setTimeout(r,800))`);
    const r = await page.eval(`(()=>{ const t=[...document.querySelectorAll('#map .leaflet-tooltip')].map(e=>({txt:e.textContent, left:e.classList.contains('leaflet-tooltip-left')}));
      return {ksfo:t.find(x=>x.txt.startsWith('KSFO')), ksea:t.find(x=>x.txt.startsWith('KSEA')), sfo:t.find(x=>x.txt==='SFO')}; })()`);
    expect(r.ksfo && /GAPP7 · radar vectors/.test(r.ksfo.txt), "KSFO label: " + JSON.stringify(r.ksfo));
    expect(r.ksea && /HAWKZ8 · fly from chart/.test(r.ksea.txt), "KSEA label: " + JSON.stringify(r.ksea));
    expect(r.sfo && r.sfo.left !== r.ksfo.left, "SFO label on the same side as KSFO's: " + JSON.stringify(r));
  } finally { await page.close(); }
});

// planning while the Route view is showing: the layout changes after the map is drawn (setup form leaves, chip bar
// appears), and the map must follow, filling its card and keeping the whole route in view
check("route-map-first-plan", async () => {
  const page = await open("c172", { width: 2000, height: 1200 });
  try {
    await page.eval(`Shell.showView('route')`);
    const err = await planFlight(page, FLIGHTS.c172); expect(!err, "plan failed: " + err);
    await page.eval(`new Promise(r=>setTimeout(r,900))`);
    const r = await page.eval(`(()=>{ const m=document.getElementById('map'), b=MAP.getBounds(), sz=MAP.getSize();
      return {view:Shell.current(), out:LAST_X.route.points.filter(p=>!b.contains([p.lat,p.lon])).map(p=>p.label), leaflet:sz.x, box:m.clientWidth}; })()`);
    expect(r.view === "route", "not on the Route view: " + r.view);
    expect(Math.abs(r.leaflet - r.box) <= 2, `Leaflet still thinks the map is ${r.leaflet} px wide, it is ${r.box} px`);
    expect(!r.out.length, "route points outside the map: " + r.out.join(" "));
  } finally { await page.close(); }
});

// airport names and other OurAirports text are shown as text, never as markup (public site, user-contributed data)
check("escape-airport-text", async () => {
  const page = await open("c172");
  try {
    await page.eval(`(()=>{ const a=DB.aptIndex.KPAO; a.name='Palo <img src=x id=xssApt onerror=window.XSS=1> Alto'; window.XSS=0; })()`);
    const err = await planFlight(page, FLIGHTS.c172); expect(!err, "plan failed: " + err);
    for (const v of ["airports", "overview", "route", "setup"]) { await page.eval(`Shell.showView(${JSON.stringify(v)})`); await settle(page); }
    const r = await page.eval(`({el:!!document.getElementById('xssApt'), ran:window.XSS, shown:document.querySelector('.aptrow[data-apt="dep"]')?.textContent.includes('<img src=x')})`);
    expect(!r.el && !r.ran, "airport name was inserted as markup");
    expect(r.shown, "airport name not shown as text in the Airports list");
  } finally { await page.close(); }
});

// title-bar data chip: the AIRAC cycle on the packs build (the website), "Live data" with the local server
check("data-chip", async () => {
  const page = await open("c172");
  try {
    const r = await page.eval(`(async()=>{ const cyc=(await (await fetch('packs/current.json')).json()).cycle; return {chip:document.getElementById('dataChip').textContent, cyc, mode:XD.mode}; })()`);
    const want = r.mode === "packs" ? `● AIRAC ${r.cyc}` : "● Live data";
    expect(r.chip === want, `chip says “${r.chip}”, expected “${want}”`);
  } finally { await page.close(); }
});

// after zooming in by hand, the map's fit-route button brings the whole route back into view
check("route-map-fitbtn", async () => {
  const page = await open("c172", { plan: true });
  try {
    await page.eval(`Shell.showView('route')`); await page.eval(`new Promise(r=>setTimeout(r,600))`);
    const inView = () => page.eval(`LAST_X.route.points.every(p=>MAP.getBounds().contains([p.lat,p.lon]))`);
    await page.eval(`MAP.setZoom(MAP.getZoom()+3,{animate:false}); new Promise(r=>setTimeout(r,300))`);
    expect(!(await inView()), "zooming in did not push the route out of view (test setup)");
    await page.click("#map .leaflet-control-fit a"); await page.eval(`new Promise(r=>setTimeout(r,600))`);
    expect(await inView(), "fit-route button did not bring the whole route back");
  } finally { await page.close(); }
});

/* ---------- landing (airliners) ---------- */
check("landing-view", async () => {
  const page = await open("b789", { plan: true });
  try {
    await page.click('.sidebar [data-view="takeoff"]'); await settle(page);
    await page.click('.tabpanel[data-tab="takeoff"] button[data-to-side="arr"]'); await settle(page);
    const r = await page.eval(`(()=>{ const p=document.querySelector('.tabpanel[data-tab="takeoff"]'), L=LAST_X.landing, B=LAST_X.briefs.arr, ap=chosenApproach(B).sel;
      return { text:p.innerText.replace(/\s+/g,' '), ok:!!L?.result, rwy:L?.end?.e?.id, apRwy:ap?.rwy, endKey:L?.end?rwyKey(L.end.e.id):null }; })()`);
    expect(r.ok, "no landing result for B789 at EGLL");
    expect(/VREF/.test(r.text) && /VAPP/.test(r.text) && /Autobrake/.test(r.text), "landing side lacks VREF / VAPP / autobrake");
    expect(!r.apRwy || r.endKey === r.apRwy, `landing runway ${r.rwy} is not the chosen approach's runway ${r.apRwy}`);
  } finally { await page.close(); }
});

// choosing an approach to a runway that is not the best for the wind: every arrival "runway in use" follows it
check("arr-runway-approach", async () => {
  const page = await open("b789", { plan: true });
  try {
    const want = await page.eval(`(()=>{ const B=LAST_X.briefs.arr, ch=chosenApproach(B), best=rwyKey(B.best.e.id);
      const o=ch.opts.find(o=>o.rwy!==best&&o.kind!=="visual")||ch.opts.find(o=>o.rwy!==best); if(!o) return null;
      const s=document.getElementById('apprSel'); s.value=o.id; s.dispatchEvent(new Event('change',{bubbles:true}));
      return B.ends.find(x=>rwyKey(x.e.id)===o.rwy).e.id; })()`);
    expect(want, "test setup: EGLL has no approach to another runway");
    await settle(page);
    const got = await page.eval(`(()=>{ const t=sel=>document.querySelector(sel)?.textContent.replace(/\s+/g,' ')||'';
      return { overview:t('[data-tile="arr-wx"] .rwy b'), list:t('.aptrow[data-apt="arr"] .aptmeta'), tile:t('[data-tile="takeoff"] [data-to-side="arr"] .tl'), landing:LAST_X.landing?.end?.e?.id }; })()`);
    expect(got.overview === "RWY " + want, `Overview arrival tile shows "${got.overview}", approach is to ${want}`);
    expect(got.list.includes("RWY " + want), `Airports list arrival row shows "${got.list}", approach is to ${want}`);
    expect(got.tile.includes(want) && got.landing === want, `landing uses ${got.landing} / tile "${got.tile}", approach is to ${want}`);
  } finally { await page.close(); }
});

check("landing-airbus-gust", async () => {
  const page = await open("b789", { plan: true });
  try {
    const r = await page.eval(`(()=>{ const L=LAST_X.landing, has=()=>landingBody(LAST_X).includes('data-ld="gustKt"'), rule=L.ac.vappRule;
      const boeing=has(); L.ac.vappRule="airbus"; const airbus=has(); L.ac.vappRule=rule; return {boeing,airbus}; })()`);
    expect(r.boeing, "Boeing landing inputs lack the gust field");
    expect(!r.airbus, "Airbus landing inputs show a gust field the Airbus rule does not use");
  } finally { await page.close(); }
});

// the Overview tile exists for every airliner plan, whatever state each side is in; GA has none
check("takeoff-tile-states", async () => {
  const page = await open("b789", { plan: true });
  try {
    const r = await page.eval(`(()=>{ const X=LAST_X, T=X.takeoff, L=X.landing, out={};
      X.takeoff={pending:true}; X.landing={pending:true}; out.pending=takeoffTile(X);
      X.takeoff={norunway:true}; X.landing=L; out.norunway=takeoffTile(X);
      X.takeoff={error:"No takeoff reference data for B789."}; out.error=takeoffTile(X);
      X.takeoff={ga:true}; X.landing={ga:true}; out.ga=takeoffTile(X);
      X.takeoff=T; X.landing=L; return out; })()`);
    expect(r.pending.includes('data-tile="takeoff"') && /Loading/.test(r.pending), "no tile while takeoff data loads");
    expect(/No runway data/.test(r.norunway) && r.norunway.includes('data-to-side="arr"') && /VAPP/.test(r.norunway), "takeoff without a runway hides the tile or its landing half");
    expect(/No takeoff reference data/.test(r.error), "takeoff error not shown in the tile");
    expect(r.ga === "", "GA aircraft got a takeoff tile");
  } finally { await page.close(); }
});

check("landing-icon", async () => {
  const page = await open("b789", { plan: true });
  try {
    const r = await page.eval(`({ sym:!!document.getElementById('i-landing'), tile:takeoffTile(LAST_X) })`);
    expect(r.sym, "no #i-landing icon");
    expect(r.tile.includes('#i-landing') && !r.tile.includes('scale(1,-1)'), "landing half still uses the flipped takeoff icon");
  } finally { await page.close(); }
});

/* ---------------- runner ---------------- */
let failed = 0, running = null;
// a run that ends mid-check (event loop drained, or killed) must say so, not just stop printing
process.on("exit", code => { if (running) console.log(`ABORT ${running}: the run ended during this check (exit code ${code})`); });
for (const c of checks) {
  if (only && !only.has(c.name)) continue;
  running = c.name;
  const t = Date.now();
  // a hung headless browser must fail the check, not freeze the whole run
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(async () => {
    const calls = [...inFlight.values()].map(c => `${c.method} for ${Math.round((Date.now() - c.since) / 1000)} s ${c.what}`).join(" | ") || "no browser call (test code)";
    const held = [...paused.values()].filter(p => Date.now() - p.since > 3000).map(p => `${p.url.replace(/^https?:\/\/[^/]+/, "")} (${Math.round((Date.now() - p.since) / 1000)} s${p.error ? ", " + p.error : ""})`);
    // the stalled evaluate does not block a second one; ask the page where it got to (bounded: the page may be wedged)
    const where = lastPage ? await Promise.race([lastPage.eval(`JSON.stringify({step:window.__pf||null,status:document.getElementById('status')?.textContent?.slice(0,120)||null})`).catch(e => "eval failed: " + e.message), new Promise(r => setTimeout(() => r("page did not answer in 5 s"), 5000))]) : "no page";
    no(new Error(`timed out after 180 s; waiting on: ${calls}; requests held by the interceptor: ${held.join(", ") || "none"}; page: ${where}`)); }, 180000); });
  try { await Promise.race([c.fn(), limit]); console.log(`PASS ${c.name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`FAIL ${c.name}: ${e.message}`); }
  finally { clearTimeout(timer); running = null; }
}
process.exit(failed ? 1 : 0);
