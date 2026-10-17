// Named UI checks for the redesign, run against replayed test flights (deterministic).
//   node tools/ui_check.mjs [--only name,name] [--mode server|packs] [--port 8770]
// Needs: python server.py 8770, and fixtures from `node tools/regress.mjs record`.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launch, replay, planFlight, FLIGHTS } from "./cdp.mjs";

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
  await page.eval(`(async()=>{ for(let i=0;i<240&&document.getElementById('go').disabled;i++) await new Promise(r=>setTimeout(r,250)); })()`);
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
    expect(JSON.stringify(views) === JSON.stringify(["overview", "route", "airports", "profile", "fuel", "setup", "settings"]), "Shell.VIEWS ids: " + views);
    for (const id of views) {
      await page.click(`.sidebar [data-view="${id}"]`); await settle(page);
      const vis = await page.eval(VISIBLE_VIEWS);
      expect(vis.length === 1 && vis[0] === id, `sidebar ${id}: visible panels ${JSON.stringify(vis)}`);
    }
    const chords = { o: "overview", r: "route", a: "airports", p: "profile", f: "fuel", s: "setup", ",": "settings" };
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
    expect(JSON.stringify(more) === JSON.stringify(["Fuel & levels", "FS2024 setup", "Settings"]), "More sheet: " + JSON.stringify(more));
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
    await page.click('[data-apt="arr"]'); await settle(page);
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
  const files = { "charts.js": strip(readFileSync(join(here, "..", "charts.js"), "utf8")), "nav.js": strip(readFileSync(join(here, "..", "nav.js"), "utf8")) };
  const html = readFileSync(join(here, "..", "index.html"), "utf8"), a = html.indexOf("function profileSVG"), b = html.indexOf("\n}\n", a);
  files["profileSVG"] = html.slice(a, b);
  const bad = Object.entries(files).map(([n, s]) => [n, [...new Set(s.match(/#[0-9a-fA-F]{3,8}\b/g) || [])].filter(h => !/^#(fff|ffffff)$/i.test(h))]).filter(([, h]) => h.length);
  expect(!bad.length, "hard-coded colours: " + bad.map(([n, h]) => `${n}: ${h.join(" ")}`).join(" | "));
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
      for (const v of ["overview", "route", "airports", "profile", "fuel", "setup", "settings"]) {
        await page.eval(`Shell.showView(${JSON.stringify(v)})`); await settle(page);
        const o = await page.eval(`({doc:document.documentElement.scrollWidth-innerWidth, surf:(s=>s.scrollWidth-s.clientWidth)(document.getElementById('surface'))})`);
        if (o.doc > 1 || o.surf > 1) bad.push(`${w}x${h} ${scheme} ${v}: page +${o.doc}px, surface +${o.surf}px`);
      }
    } finally { await page.close(); }
  }
  expect(!bad.length, "horizontal overflow:\n    " + bad.join("\n    "));
});

/* ---------------- runner ---------------- */
let failed = 0;
for (const c of checks) {
  if (only && !only.has(c.name)) continue;
  const t = Date.now();
  try { await c.fn(); console.log(`PASS ${c.name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`FAIL ${c.name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
