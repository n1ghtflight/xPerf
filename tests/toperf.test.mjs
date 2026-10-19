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

test("certified climb: one-engine-out minimum met at MTOW, sea level, ISA, lowest flap", () => {
  for (const c of AC_CODES) {
    const ac = acOf(c), r = fl(ac, { massKg: ac.mtow }, ac.flaps[0].level, 15), min = [0, 0, 0.024, 0.027, 0.030][ac.nEng];
    assert.ok(r.grad2 >= min, `${c}: ${(r.grad2 * 100).toFixed(1)} % < ${min * 100} %`);
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
