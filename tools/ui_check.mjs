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

/* ---------------- runner ---------------- */
let failed = 0;
for (const c of checks) {
  if (only && !only.has(c.name)) continue;
  const t = Date.now();
  try { await c.fn(); console.log(`PASS ${c.name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`FAIL ${c.name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
