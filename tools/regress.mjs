// Pin XPerf's planning output for the three test flights, in both data modes.
//   node tools/regress.mjs record  [--mode server|packs] [--flight c172|sr22|b789]
//   node tools/regress.mjs compare [--mode server|packs] [--flight c172|sr22|b789]
// record: plans live, saves network fixtures (gitignored) + a baseline snapshot (committed).
// compare: replays the fixtures and diffs the snapshot against the baseline; exit 1 on any difference.
// Needs the app server running: python server.py 8770
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, record, replay, planFlight, FLIGHTS } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), cmd = args[0];
const opt = n => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : null; };
const port = +(opt("port") || 8770);
const modes = opt("mode") ? [opt("mode")] : ["server", "packs"];
const flights = opt("flight") ? [opt("flight")] : Object.keys(FLIGHTS);
if (!["record", "compare"].includes(cmd)) { console.error("usage: node tools/regress.mjs record|compare [--mode m] [--flight f]"); process.exit(2); }

const fixture = (m, f) => join(here, "regress", "fixtures", `${m}-${f}.json`);
const baseline = (m, f) => join(here, "regress", "baseline", `${m}-${f}.json`);

// Defined in the page: a canonical, rounded view of everything a user can see or export from a plan.
const SNAPSHOT_JS = `window.regressSnapshot=async()=>{
  const X=window.LAST_X, err=document.getElementById('err').textContent;
  if(!X) return {err};
  const canon=(v,d=0)=>{
    if(v==null||typeof v==='boolean'||typeof v==='string') return v;
    if(typeof v==='number') return Number.isFinite(v)?Math.round(v*1000)/1000:String(v);
    if(typeof v==='function') return undefined;
    if(d>5) return '…';
    if(Array.isArray(v)) return v.map(x=>canon(x,d+1));
    if(typeof v==='object'){ if(v.icao&&v.lat!=null) return 'apt:'+v.icao; if(v.ident&&v.lat!=null) return 'nav:'+v.ident;
      const o={}; for(const k of Object.keys(v).sort()){ const c=canon(v[k],d+1); if(c!==undefined) o[k]=c; } return o; }
    return String(v); };
  const {sel,total}=X, c=sel.climb, d=sel.descent;
  const hooks=sel=>{ const inv=new Set(); document.querySelectorAll(sel).forEach(e=>{ if(e.id) inv.add('#'+e.id);
    for(const a of e.getAttributeNames()) if(a.startsWith('data-')) inv.add('['+a+']'); }); return [...inv].sort(); };
  return canon({err, cruiseFt:sel.ft, totalNM:nm(total), timeS:sel.time, tripKg:sel.trip, blockKg:sel.block,
    toc:{dNM:nm(c.d),tS:c.t}, tod:{dNM:nm(d.d),tS:d.t},
    levels:X.results.map(r=>({ft:r.ft,tripKg:r.trip,timeS:r.time,allowed:r.allowed})),
    route:X.route.points.map(p=>p.label), legs:X.legs, warnings:planWarnings(X), pln:(await buildPLN(X)).xml,
    inventory:hooks('#results *'), inventoryAll:hooks('body *')});
};`;

function diff(a, b, path = "$", out = []) {
  if (out.length >= 25) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) { out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`.slice(0, 300)); return out; }
  if (a && typeof a === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`.slice(0, 300));
  return out;
}

let failures = 0, done = 0;
for (const mode of modes) for (const f of flights) {
  const label = `${mode}-${f}`;
  if (cmd === "compare" && !existsSync(baseline(mode, f))) { console.log(`FAIL ${label}: missing baseline ${baseline(mode, f)} — run record first`); failures++; continue; }
  const page = await launch({ port, query: mode === "packs" ? "data=packs" : "" });
  try {
    const rec = cmd === "record" ? await record(page, fixture(mode, f)) : (await replay(page, fixture(mode, f)), null);
    await page.goto("/");
    await planFlight(page, FLIGHTS[f]);
    await page.eval(SNAPSHOT_JS);
    const snap = await page.eval("window.regressSnapshot()");
    if (cmd === "record") {
      mkdirSync(dirname(baseline(mode, f)), { recursive: true });
      delete snap.inventoryAll;
      writeFileSync(baseline(mode, f), JSON.stringify(snap, null, 1));
      console.log(`recorded ${label}: ${rec.save()} responses, cruise ${snap.cruiseFt} ft, err "${snap.err || ""}"`);
    } else {
      // inventory = hooks that existed after a plan; they may move or gain siblings, but none may disappear
      const base = JSON.parse(readFileSync(baseline(mode, f), "utf8")), all = new Set(snap.inventoryAll || []);
      const gone = (base.inventory || []).filter(h => !all.has(h));
      delete base.inventory; delete base.inventoryAll; delete snap.inventory; delete snap.inventoryAll;
      const d = diff(base, snap);
      if (gone.length) d.unshift("removed UI hooks: " + gone.join(", "));
      if (page.misses.length) d.unshift(...page.misses.slice(0, 5).map(m => `unrecorded request: ${m}`));
      if (d.length) { failures++; console.log(`FAIL ${label}:\n  ` + d.join("\n  ")); }
      else { done++; console.log(`ok   ${label}`); }
    }
  } catch (e) { failures++; console.log(`FAIL ${label}: ${e.message}`); }
  finally { await page.close(); }
}
if (cmd === "compare") console.log(failures ? `${failures} differ, ${done} identical` : `${done}/${done} identical`);
process.exit(failures ? 1 : 0);
