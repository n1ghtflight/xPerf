// Build tests/fixtures/to_aircraft.json: the slice of XPerf's OpenAP model (m) that the takeoff model reads,
// for every OpenAP type, so tests/toperf.test.mjs runs offline. Same engine lookup as loadOpenapModel (index.html).
//   node tools/to_fixture.mjs        (needs internet; re-run when OpenAP data changes)
import { readFileSync, writeFileSync } from "node:fs";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const html = read("index.html");
const BASE = html.match(/const OPENAP_MIRRORS = \["([^"]+)"/)[1];
const CODES = [...html.match(/const AC_NAMES = \{([^}]*)\}/)[1].matchAll(/([a-z0-9]+):"/g)].map(m => m[1]);
const G0 = 9.80665;

const get = async p => { const r = await fetch(BASE + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); };
// minimal YAML (OpenAP's aircraft files: nested maps of scalars), same rules as parseYaml in index.html
function yaml(txt) {
  const root = {}, stack = [{ ind: -1, obj: root }];
  const val = v => v === "null" || v === "~" ? null : isNaN(+v) ? v.replace(/^["']|["']$/g, "") : +v;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd(); if (!line.trim() || line.trim().startsWith("#")) continue;
    const ind = line.match(/^ */)[0].length, s = line.trim();
    while (stack.length > 1 && ind <= stack[stack.length - 1].ind) stack.pop();
    const parent = stack[stack.length - 1].obj, i = s.indexOf(":"); if (i < 0 || s.startsWith("- ")) continue;
    const k = s.slice(0, i).trim(), v = s.slice(i + 1).trim();
    if (v === "") { parent[k] = {}; stack.push({ ind, obj: parent[k] }); } else parent[k] = val(v);
  }
  return root;
}
const csv = txt => { const [h, ...rows] = txt.trim().split(/\r?\n/).map(l => l.split(","));
  return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

const engines = csv(await get("engine/engines.csv"));
const findEngine = name => { if (!name) return null; const N = String(name).toUpperCase();
  return engines.find(e => e.name.toUpperCase() === N) || engines.find(e => e.name.toUpperCase().startsWith(N)) || null; };

const out = {};
for (const code of CODES) {
  const ac = yaml(await get(`aircraft/${code}.yml`)), nEng = ac.engine?.number || 2;
  const e = findEngine(ac.engine?.default) || findEngine(ac.fuel?.engine);
  const eng = e ? { name: e.name, max_thrust: +e.max_thrust, bpr: +e.bpr }
    : { name: (ac.engine?.default || "generic") + " (estimated)", max_thrust: 0.30 * ac.mtow * G0 / nEng, bpr: 5, estimated: true };
  out[code] = { code, nEng, eng,
    ac: { mtow: ac.mtow, mlw: ac.mlw, wing: { area: ac.wing?.area, span: ac.wing?.span }, fuselage: { length: ac.fuselage?.length },
          drag: { cd0: ac.drag?.cd0 ?? null, k: ac.drag?.k ?? null, gears: ac.drag?.gears ?? null } },
    polar: { cd0: ac.drag?.cd0 ?? 0.02, k: ac.drag?.k ?? 0.045 } };
}
writeFileSync(new URL("../tests/fixtures/to_aircraft.json", import.meta.url), (JSON.stringify(out, null, 1) + "\n").replace(/\n/g, "\r\n"));
console.log(`${Object.keys(out).length} types → tests/fixtures/to_aircraft.json (${Object.values(out).filter(m => m.eng.estimated).map(m => m.code).join(" ") || "no"} estimated engines)`);
