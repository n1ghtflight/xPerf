// Unit tests for blueprint.js (pure functions; no DOM). Run: node --test tests/blueprint.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../blueprint.js", import.meta.url), "utf8"), ctx);
const { aircraftSpec, blueprintSVG, BLUEPRINT_TRAITS } = ctx;
const plain = x => JSON.parse(JSON.stringify(x));

const C172 = { code: "C172", kind: "piston", n: 1, span: 11.0, mtow: 1157 };
const A320 = { code: "A320", kind: "jet", n: 2, span: 35.8, length: 37.57, width: 3.95, area: 124, sweep: 25, mount: "wing", mtow: 78000 };

test("every listed aircraft type has a trait entry", () => {
  const ga = Object.keys(JSON.parse(readFileSync(new URL("../data/ga_perf.json", import.meta.url), "utf8")).types);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const oap = [...html.match(/const AC_NAMES = \{([^}]*)\}/)[1].matchAll(/([a-z0-9]+):"/g)].map(m => m[1].toUpperCase());
  assert.equal(ga.length, 82); assert.ok(oap.length >= 37, "OpenAP list not found");
  const missing = [...ga, ...oap].filter(c => !(c in BLUEPRINT_TRAITS));
  assert.deepEqual(missing, []);
});

test("C172: high wing, conventional tail, nose propeller, estimated length", () => {
  const s = plain(aircraftSpec(C172));
  assert.equal(s.wing, "high"); assert.equal(s.tail, "conv"); assert.equal(s.mount, "nose");
  assert.equal(s.lengthReal, false); assert.ok(s.length > 7 && s.length < 9.5, "length " + s.length);
});

test("airliner geometry comes from the data, the CRJ900's rear engines from the traits", () => {
  const a = plain(aircraftSpec(A320));
  assert.equal(a.length, 37.57); assert.equal(a.lengthReal, true); assert.equal(a.mount, "wing"); assert.equal(a.sweep, 25);
  const c = plain(aircraftSpec({ code: "CRJ9", kind: "jet", n: 2, span: 23.24, length: 33.5, mount: "wing" }));
  assert.equal(c.mount, "rear"); assert.equal(c.tail, "T");
});

test("an unknown type falls back on its engine kind and count", () => {
  assert.equal(plain(aircraftSpec({ code: "ZZ99", kind: "piston", n: 2, span: 12 })).mount, "wing");
  const j = plain(aircraftSpec({ code: "ZZ98", kind: "jet", n: 2, span: 16, mtow: 9000 }));
  assert.equal(j.mount, "rear"); assert.equal(j.tail, "T");
  assert.equal(plain(aircraftSpec({ code: "ZZ97", kind: "jet", n: 2, span: 40, mtow: 80000 })).mount, "wing");
});

test("the drawing labels the real wingspan, and the length only when it is real data", () => {
  const ga = blueprintSVG(aircraftSpec(C172));
  assert.match(ga, /11\.00 m/); assert.doesNotMatch(ga, /\d+\.\d\d m<\/text>[\s\S]*\d+\.\d\d m<\/text>/);
  const jet = blueprintSVG(aircraftSpec(A320));
  assert.match(jet, /35\.80 m/); assert.match(jet, /37\.57 m/);
});

test("engines are drawn where the type has them", () => {
  const count = (svg, cls) => (svg.match(new RegExp(`class="bp-${cls}"`, "g")) || []).length;
  assert.equal(count(blueprintSVG(aircraftSpec(A320)), "pod"), 2);
  assert.equal(count(blueprintSVG(aircraftSpec({ code: "B744", kind: "jet", n: 4, span: 64.4, length: 70.66, mount: "wing" })), "pod"), 4);
  assert.equal(count(blueprintSVG(aircraftSpec({ code: "BE58", kind: "piston", n: 2, span: 11.53 })), "prop"), 2);
  assert.equal(count(blueprintSVG(aircraftSpec(C172)), "prop"), 1);
  assert.equal(count(blueprintSVG(aircraftSpec({ code: "F900", kind: "jet", n: 3, span: 21.39 })), "pod"), 3);
});

test("colours come from tokens only, and the label is escaped", () => {
  const svg = blueprintSVG(aircraftSpec({ ...C172, code: "<b>" }));
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b/i);
  assert.doesNotMatch(svg, /<b>/);
  assert.match(svg, /var\(--bp-line\)/);
});

test("every type draws without NaN", () => {
  for (const code of Object.keys(BLUEPRINT_TRAITS)) {
    const svg = blueprintSVG(aircraftSpec({ code, kind: "piston", n: 1, span: 11 }));
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/, code);
  }
});
