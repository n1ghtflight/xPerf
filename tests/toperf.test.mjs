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
