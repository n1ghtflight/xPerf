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

/* ---------------- runner ---------------- */
let failed = 0;
for (const c of checks) {
  if (only && !only.has(c.name)) continue;
  const t = Date.now();
  try { await c.fn(); console.log(`PASS ${c.name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.log(`FAIL ${c.name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
