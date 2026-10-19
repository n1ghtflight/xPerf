// Unit tests for the takeoff model (toperf.js), its data files and the plan → inputs step (takeoff.js).
// Pure functions, no DOM. Run: node --test tests/toperf.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
