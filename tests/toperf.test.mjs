// Unit tests for the takeoff model (toperf.js), its data files and the plan → inputs step (takeoff.js).
// Pure functions, no DOM. Run: node --test tests/toperf.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const AC_CODES = [...read("index.html").match(/const AC_NAMES = \{([^}]*)\}/)[1].matchAll(/([a-z0-9]+):"/g)].map(m => m[1]);

test("to_ref covers every OpenAP type with sane values", () => {
  const ref = JSON.parse(read("data/to_ref.json")).types;
  assert.ok(AC_CODES.length >= 37, "OpenAP list not found");
  const order = { low: 0, mid: 1, high: 2 };
  for (const c of AC_CODES) {
    const r = ref[c];
    assert.ok(r, `${c}: missing`);
    assert.ok(r.vrefMLW.v >= 100 && r.vrefMLW.v <= 175, `${c}: vref ${r.vrefMLW.v}`);
    assert.ok(["pub", "est"].includes(r.vrefMLW.s), `${c}: status ${r.vrefMLW.s}`);
    assert.ok(r.vrefMLW.src, `${c}: no source`);
    assert.ok(r.flaps.length >= 1 && r.flaps.length <= 5, `${c}: ${r.flaps.length} flap settings`);
    r.flaps.forEach((f, i) => {
      assert.ok(f.level in order, `${c}: level ${f.level}`);
      if (i) assert.ok(order[f.level] >= order[r.flaps[i - 1].level], `${c}: levels out of order`);
    });
    assert.ok(["FLEX", "Assumed temp", "TO temp"].includes(r.label), `${c}: label ${r.label}`);
  }
});

/* ---------------------------------------------------------------- model (toperf.js) */
const ctx = vm.createContext({});
if (existsSync(new URL("../toperf.js", import.meta.url))) vm.runInContext(read("toperf.js"), ctx);
const TOPerf = () => { assert.ok(ctx.TOPerf, "TOPerf not defined"); return ctx.TOPerf; };
const REF = JSON.parse(read("data/to_ref.json")).types;
const FIX = existsSync(new URL("fixtures/to_aircraft.json", import.meta.url)) ? JSON.parse(read("tests/fixtures/to_aircraft.json")) : {};
const acOf = code => TOPerf().acFromModel(FIX[code], REF[code], null);
const env0 = { massKg: 70000, paFt: 0, oat: 15, hwKt: 0, slopePct: 0, wet: false, bleed: 1 };
const fl = (ac, env = {}, level = "low", T) => { const e = { ...env0, ...env }; return TOPerf().fieldLength(ac, e, level, T ?? e.oat); };
const finite = o => Object.entries(o).every(([k, v]) => typeof v !== "number" || Number.isFinite(v));

test("speeds ordered", () => {
  for (const c of ["a20n", "b738"]) {
    const r = fl(acOf(c));
    assert.ok(finite(r), JSON.stringify(r));
    assert.ok(r.vs < r.v1 && r.v1 <= r.vr && r.vr < r.v2, `${c}: ${r.vs} ${r.v1} ${r.vr} ${r.v2}`);
  }
});

test("heavier, hotter, higher, uphill are longer", () => {
  const ac = acOf("a20n"), base = fl(ac).requiredM;
  for (const env of [{ massKg: 76000 }, { oat: 35 }, { paFt: 5000 }, { slopePct: 1 }])
    assert.ok(fl(ac, env).requiredM > base, JSON.stringify(env));
});

test("headwind shorter, tailwind longer", () => {
  const ac = acOf("a20n"), base = fl(ac).requiredM, head = fl(ac, { hwKt: 10 }), tail = fl(ac, { hwKt: -10 });
  assert.ok(finite(head) && finite(tail));
  assert.ok(head.requiredM < base && tail.requiredM > base);
});

test("wet lowers V1", () => {
  const ac = acOf("a20n");
  assert.ok(fl(ac, { wet: true }).v1 < fl(ac).v1);
});

test("higher assumed temperature needs more runway", () => {
  const ac = acOf("a20n");
  assert.ok(fl(ac, {}, "low", 50).requiredM > fl(ac, {}, "low", 15).requiredM);
});

test("every type computes at MTOW", () => {
  assert.ok(Object.keys(FIX).length >= 37, "fixture missing");
  for (const c of AC_CODES) {
    const ac = acOf(c), r = fl(ac, { massKg: ac.mtow }, "mid", 15);
    assert.ok(finite(r), `${c}: ${JSON.stringify(r)}`);
    assert.ok(r.requiredM > 800 && r.requiredM < 4500, `${c}: ${Math.round(r.requiredM)} m`);
  }
});

test("certified climb: one-engine-out minimum met with margin at MTOW, sea level, ISA, lowest flap, packs on", () => {
  // certified types are field-limited, not climb-limited, at sea level ISA: keep at least 0.3 points above the minimum
  for (const c of AC_CODES) {
    const ac = acOf(c), r = fl(ac, { massKg: ac.mtow, bleed: 0.985 }, ac.flaps[0].level, 15), min = [0, 0, 0.024, 0.027, 0.030][ac.nEng] + 0.003;
    assert.ok(r.grad2 >= min, `${c}: ${(r.grad2 * 100).toFixed(1)} % < ${(min * 100).toFixed(1)} %`);
  }
});

test("engine overrides in to_ref replace OpenAP's default engine", () => {
  for (const c of AC_CODES) if (REF[c].engine) {
    const ac = acOf(c);
    assert.equal(ac.thrust0, REF[c].engine.thrustN, c); assert.equal(ac.bpr, REF[c].engine.bpr, c);
    assert.ok(REF[c].engine.src, `${c}: no source`);
  }
  assert.ok(REF.b39m.engine, "b39m override missing");
});

/* ---------------------------------------------------------------- compute(): reduced thrust, flaps, limits */
const inp0 = { towKg: 70000, elevFt: 13, qnh: 1013, oat: 18, windKt: 0, slopePct: 0, lengthFt: 11870, intersectionFt: 0,
  lineup: "none", wet: false, packs: true, antiIce: "off", thrust: "reduced", flap: "optimum" };
const run = (inp = {}, code = "a20n") => TOPerf().compute(acOf(code), { ...inp0, ...inp });
const allFinite = res => res.byFlap.every(f => finite(f)) && Number.isFinite(res.shortfallFt);

test("reduced thrust on a long runway", () => {
  const ac = acOf("a20n"), r = run();
  assert.equal(r.status, "reduced");
  assert.ok(r.selected.assumedT >= 18 && r.selected.thrustRed <= 0.25, JSON.stringify(r.selected));
  assert.ok(ac.flaps.some(f => f.name === r.optimum), r.optimum);
  assert.equal(r.byFlap.length, ac.flaps.length);
});

test("short runway gives TOGA only", () => {
  const flap = run().optimum, full = run({ thrust: "full", flap }).selected.requiredFt, r = run({ lengthFt: full * 1.002, flap });   // any temperature above the flat-rating point would need more
  assert.equal(r.status, "toga"); assert.equal(r.selected.assumedT, null);
});

test("too short does not fit", () => {
  const r = run({ lengthFt: 4000 });
  assert.equal(r.status, "nofit"); assert.ok(r.shortfallFt > 0); assert.ok(allFinite(r));
});

test("intersection beyond the runway clamps", () => {
  const r = run({ intersectionFt: 20000 });
  assert.equal(r.selected.availableFt, 0); assert.equal(r.status, "nofit");
  assert.equal(run({ intersectionFt: -50 }).selected.availableFt, run().selected.availableFt);
});

test("tailwind uses 150 %", () => {
  const T = run({ thrust: "full" }), tail = run({ thrust: "full", windKt: -10 }), head = run({ thrust: "full", windKt: 10 });
  assert.ok(tail.selected.requiredFt > T.selected.requiredFt && tail.selected.requiredFt > head.selected.requiredFt);
  // 10 kt tail counts as 15 kt; 10 kt head as 5 kt: the tailwind penalty is the larger one
  assert.ok(tail.selected.requiredFt - T.selected.requiredFt > T.selected.requiredFt - head.selected.requiredFt);
});

test("anti-ice and packs lower the temperature", () => {
  // runway-limited (not at the 25 % thrust cap, which bleed doesn't change)
  const L = { lengthFt: 7000 };
  assert.ok(run({ ...L, antiIce: "wing" }).selected.assumedT < run(L).selected.assumedT);
  assert.ok(run({ ...L, packs: false }).selected.assumedT >= run(L).selected.assumedT);
});

test("wet never raises the temperature", () => {
  assert.ok(run({ wet: true }).selected.assumedT <= run().selected.assumedT);
});

test("above MTOW still computes with a note", () => {
  const ac = acOf("a20n"), r = run({ towKg: ac.mtow + 2000 });
  assert.ok(allFinite(r)); assert.ok(r.notes.includes("Takeoff weight above MTOW"));
});

test("climb-limited weight is not a field-length fit", () => {
  // very hot and high: the one-engine-out gradient fails even with full thrust on a long runway
  const r = run({ towKg: 79000, elevFt: 8000, oat: 40, lengthFt: 16000 });
  assert.equal(r.status, "nofit"); assert.ok(r.selected.limits.some(l => l.id === "grad2" && !l.ok));
});

test("fast enough", () => {
  const ac = acOf("b77w"), t0 = performance.now();
  for (let i = 0; i < 20; i++) TOPerf().compute(ac, { ...inp0, towKg: 300000, lengthFt: 13000 });
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
});

/* ---------------------------------------------------------------- tuning to airport-planning charts */
const TUNE = JSON.parse(read("data/to_tune.json")).types;

test("tuned types match the charts within 5 %", () => {
  assert.ok(Object.keys(TUNE).length >= 1, "no tuned types");
  for (const [c, t] of Object.entries(TUNE)) {
    assert.ok(t.points.length >= 3, `${c}: ${t.points.length} points`);
    const ac = TOPerf().acFromModel(FIX[c], REF[c], t);
    for (const r of TOPerf().tuningReport(ac, t.points))
      assert.ok(Math.abs(r.errPct) <= 5, `${c} ${JSON.stringify(r.point)}: model ${Math.round(r.modelFt)} ft vs chart ${r.chartFt} ft (${r.errPct.toFixed(1)} %)`);
  }
});

test("untuned types have no factor", () => {
  const c = AC_CODES.find(x => !TUNE[x]);
  assert.equal(TOPerf().acFromModel(FIX[c], REF[c], TUNE[c] || null).tune, null);
});

/* ---------------------------------------------------------------- plan → inputs (takeoff.js) */
if (existsSync(new URL("../takeoff.js", import.meta.url))) vm.runInContext(read("takeoff.js"), ctx);
const toInputs = (...a) => { assert.ok(ctx.toInputs, "toInputs not defined"); return ctx.toInputs(...a); };
const metar = { temp: 18, qnh: 1016, wdir: 290, wspd: 14, wgst: 0, wet: false, vrb: false, raw: "KSFO 181756Z 29014KT 10SM FEW008 18/12 A3000" };
const planX = (met, elev = 13) => ({ m: { kind: "openap", code: "a20n" }, sel: { tow: 70000 },
  briefs: { dep: { a: { icao: "KSFO", alt: elev }, met } } });
const end28R = (elev = 13) => ({ r: { length: 11870, surface: "ASP" }, e: { id: "28R", elev, hdgT: 284 }, o: { elev: elev - 3 } });
const OPTS = { flap: "optimum", thrust: "reduced", packs: true, antiIce: "off" };

test("METAR values flow through with sources", () => {
  const { input, src } = toInputs(planX(metar), end28R(), {}, OPTS);
  assert.equal(input.oat, 18); assert.equal(input.qnh, 1016);
  assert.ok(Math.abs(input.windKt - 14 * Math.cos(6 * Math.PI / 180)) < 0.5, String(input.windKt));
  assert.equal(src.oat, "METAR 1756Z"); assert.equal(input.towKg, 70000); assert.equal(input.lengthFt, 11870);
  assert.ok(input.slopePct < 0, "downhill toward the far end");
});

test("no METAR assumes ISA and calm", () => {
  const { input, src } = toInputs(planX(null, 1000), end28R(1000), {}, OPTS);
  assert.equal(input.oat, 13); assert.equal(input.qnh, 1013.25); assert.equal(input.windKt, 0); assert.equal(input.wet, false);
  for (const k of ["oat", "qnh", "windKt", "wet"]) assert.equal(src[k], "assumed — no METAR", k);
});

test("VRB wind is zero headwind", () => {
  assert.equal(toInputs(planX({ ...metar, vrb: true, wdir: null }), end28R(), {}, OPTS).input.windKt, 0);
});

test("overrides win and are marked", () => {
  const { input, src } = toInputs(planX(metar), end28R(), { oat: 30 }, OPTS);
  assert.equal(input.oat, 30); assert.equal(src.oat, "edited");
});

test("GA aircraft gets the pointer", () => {
  assert.ok(ctx.takeoffResult, "takeoffResult not defined");
  assert.equal(ctx.takeoffResult({ m: { kind: "apm" } }).ga, true);
});

/* ---------------------------------------------------------------- review fixes */
test("no NaN when one engine out cannot accelerate or climb", () => {
  for (const c of AC_CODES) {
    const ac = acOf(c);
    for (const towKg of [ac.mtow, 1.3 * ac.mtow, 3 * ac.mtow]) for (const [elevFt, oat] of [[0, 15], [9000, 30], [13300, 15]]) for (const slopePct of [0, 1]) {
      const r = TOPerf().compute(ac, { ...inp0, towKg, elevFt, oat, slopePct, lengthFt: 12000 });
      for (const f of r.byFlap) for (const [k, v] of Object.entries(f)) if (typeof v === "number")
        assert.ok(!Number.isNaN(v), `${c} ${towKg} kg ${elevFt} ft ${oat} °C ${slopePct} %: ${f.flap}.${k} is NaN`);
      assert.ok(!Number.isNaN(r.shortfallFt), `${c}: shortfall NaN`);
      for (const f of r.byFlap) if (!Number.isFinite(f.requiredFt)) assert.equal(f.fits, false);
      if (!Number.isFinite(r.selected.requiredFt)) assert.equal(r.status, "nofit");
    }
  }
});

test("compute survives nonsense numbers", () => {
  for (const bad of [{ towKg: 0 }, { towKg: -5 }, { qnh: 0 }, { oat: -300 }])
    for (const f of run(bad).byFlap) assert.ok(Object.values(f).every(v => typeof v !== "number" || !Number.isNaN(v)), JSON.stringify(bad));
});

test("out-of-range typed values are ignored", () => {
  const { input, src } = toInputs(planX(metar), end28R(), { towKg: 0, qnh: 0, oat: -300, slopePct: 50, elevFt: 99999, lengthFt: -10 }, OPTS);
  assert.equal(input.towKg, 70000); assert.equal(input.qnh, 1016); assert.equal(input.oat, 18);
  assert.ok(Math.abs(input.slopePct) < 1); assert.equal(input.elevFt, 13); assert.equal(input.lengthFt, 11870);
  for (const k of ["towKg", "qnh", "oat", "slopePct", "elevFt", "lengthFt"]) assert.notEqual(src[k], "edited", k);
});

test("runway-specific overrides stay with their runway", () => {
  const ov = { oat: 25, byRwy: { "28R": { lengthFt: 9000, intersectionFt: 1000, lineup: "90" } } };
  const on28 = toInputs(planX(metar), end28R(), ov, OPTS).input;
  assert.equal(on28.lengthFt, 9000); assert.equal(on28.intersectionFt, 1000); assert.equal(on28.lineup, "90"); assert.equal(on28.oat, 25);
  const e10 = { ...end28R(), e: { id: "10L", elev: 10, hdgT: 104 } }, on10 = toInputs(planX(metar), e10, ov, OPTS).input;
  assert.equal(on10.lengthFt, 11870); assert.equal(on10.intersectionFt, 0); assert.equal(on10.lineup, "none"); assert.equal(on10.oat, 25);
});

/* ================================================================ landing */
test("landing reference data per type", () => {
  for (const c of AC_CODES) {
    const r = REF[c];
    assert.ok(Array.isArray(r.landingFlaps) && r.landingFlaps.length >= 1 && r.landingFlaps.length <= 2, `${c}: landingFlaps`);
    assert.equal(r.landingFlaps.filter(f => f.default).length, 1, `${c}: one default landing flap`);
    for (const f of r.landingFlaps) assert.ok(f.frac > 0.8 && f.frac <= 1, `${c}: frac ${f.frac}`);
    const ab = r.autobrake; assert.ok(Array.isArray(ab) && ab.length >= 1, `${c}: autobrake`);
    assert.deepEqual(ab[ab.length - 1], { name: "Max manual", decel: null }, `${c}: last autobrake`);
    ab.slice(0, -1).forEach((a, i, arr) => { assert.ok(a.decel > 0.5 && a.decel < 5, `${c}: ${a.name} ${a.decel}`); if (i) assert.ok(a.decel > arr[i - 1].decel, `${c}: ascending`); });
    assert.ok(["airbus", "boeing"].includes(r.vapp), `${c}: vapp ${r.vapp}`);
  }
});
