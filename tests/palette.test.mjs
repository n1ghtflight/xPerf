// Unit tests for palette.js (pure functions; no DOM). Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const apt = (icao, name, iata = "") => ({ icao, name, iata, country: "US", lat: 0, lon: 0, alt: 0 });
const AIRPORTS = [apt("KPAO", "Palo Alto Airport"), apt("KTRK", "Truckee Tahoe Airport"), apt("KSFO", "San Francisco International Airport", "SFO"),
  apt("KLAX", "Los Angeles International Airport", "LAX"), apt("EGLL", "London Heathrow Airport", "LHR"),
  apt("KSPI", "Abraham Lincoln Capital Airport Springfield"), apt("KSGF", "Springfield-Branson National Airport")];
const aptIndex = {}; for (const a of AIRPORTS) { aptIndex[a.icao] = a; if (a.iata) aptIndex[a.iata] = a; }
const AIRCRAFT = [{ value: "apm:C172", code: "C172", name: "Cessna 172 Skyhawk" }, { value: "oap:b738", code: "B738", name: "Boeing 737-800" }];
const lookups = { aptIndex, airports: AIRPORTS, aircraft: AIRCRAFT };

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../palette.js", import.meta.url), "utf8"), ctx);
const { parseTypedPlan, filterCommands } = ctx;

test("ICAO pair with aircraft code plans that aircraft", () => {
  const r = parseTypedPlan("KPAO KTRK C172", lookups);
  assert.equal(r.kind, "plan"); assert.equal(r.dep.icao, "KPAO"); assert.equal(r.arr.icao, "KTRK"); assert.equal(r.ac, "apm:C172");
});
test("lowercase with an arrow separator and no aircraft keeps the current aircraft", () => {
  const r = parseTypedPlan("kpao → ktrk", lookups);
  assert.equal(r.kind, "plan"); assert.equal(r.dep.icao, "KPAO"); assert.equal(r.arr.icao, "KTRK"); assert.equal(r.ac, null);
});
test("IATA codes and 'to' resolve, aircraft code is case-insensitive", () => {
  const r = parseTypedPlan("SFO to LAX b738", lookups);
  assert.equal(r.kind, "plan"); assert.equal(r.dep.icao, "KSFO"); assert.equal(r.arr.icao, "KLAX"); assert.equal(r.ac, "oap:b738");
});
test("a name matching several airports is ambiguous and lists them", () => {
  const r = parseTypedPlan("KPAO SPRINGFIELD", lookups);
  assert.equal(r.kind, "ambiguous"); assert.equal(r.field, "arr"); assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map(a => a.icao).sort(), ["KSGF", "KSPI"]);
});
test("an arrival that matches nothing is unknown", () => {
  const r = parseTypedPlan("KPAO ZZZZ", lookups);
  assert.equal(r.kind, "unknown"); assert.equal(r.field, "arr"); assert.equal(r.token, "ZZZZ");
});
test("an aircraft code that matches nothing is unknown", () => {
  const r = parseTypedPlan("KPAO KTRK XX99", lookups);
  assert.equal(r.kind, "unknown"); assert.equal(r.field, "ac"); assert.equal(r.token, "XX99");
});
test("a single word is not a plan", () => {
  assert.equal(parseTypedPlan("export", lookups).kind, "none");
});
test("ordinary command text whose first word is not an airport is not a plan", () => {
  assert.equal(parseTypedPlan("dark theme", lookups).kind, "none");
});
test("filterCommands matches label substrings case-insensitively and keeps group order", () => {
  const cmds = [{ group: "This plan", label: "Export .PLN" }, { group: "This plan", label: "Copy route" },
    { group: "Navigate", label: "Go to Profile" }, { group: "App", label: "Switch theme" }];
  assert.deepEqual(filterCommands(cmds, "pln").map(c => c.label), ["Export .PLN"]);
  assert.deepEqual(filterCommands(cmds, "o").map(c => c.group), ["This plan", "This plan", "Navigate"]);
  assert.equal(filterCommands(cmds, "").length, 4);
});
