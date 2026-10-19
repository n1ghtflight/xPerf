// Unit tests for routeimport.js (pure functions; no DOM). Run: node --test tests/routeimport.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../routeimport.js", import.meta.url), "utf8"), ctx);
const { tokenizeRoute, parseCoord, resolveRoute, parseSimbriefXML, routeProcedures, procedureLabel } = ctx;
// values built inside the vm realm have its Array prototype: compare as plain data
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

// a tiny world: Bay Area → Truckee, plus a second "SAC" far away to test nearest-candidate choice
const APTS = { KPAO: { icao: "KPAO", lat: 37.461, lon: -122.115 }, KTRK: { icao: "KTRK", lat: 39.320, lon: -120.140 },
  KSQL: { icao: "KSQL", lat: 37.512, lon: -122.250 } };
const FIXES = {
  SJC: [{ id: "SJC", lat: 37.375, lon: -121.945, kind: "nav" }],
  SAC: [{ id: "SAC", lat: 38.444, lon: -121.552, kind: "nav" }, { id: "SAC", lat: 10.0, lon: 10.0, kind: "nav" }],
  OAK: [{ id: "OAK", lat: 37.726, lon: -122.224, kind: "nav" }],
};
const V334 = [{ id: "X1", lat: 37.9, lon: -121.8, kind: "fix" }, { id: "SAC", lat: 38.444, lon: -121.552, kind: "nav" }];
const lookups = (extra = {}) => ({
  dep: APTS.KPAO, arr: APTS.KTRK,
  findApt: id => APTS[id] || null,
  findFix: id => FIXES[id] || [],
  airway: (name, from, toId) => name === "V334" && from.id === "SJC" && toId === "SAC" ? V334 : null,
  ...extra,
});
const ids = r => r.points.map(p => p.id).join(" ");

test("tokenizer drops DCT, speed/level groups and slash suffixes", () => {
  eq(tokenizeRoute(" kpao/31 N0120A065 DCT sjc  V334 SAC/N0125A075 DCT KTRK/20 "), ["KPAO", "SJC", "V334", "SAC", "KTRK"]);
});

test("coordinate tokens in ICAO, short and ARINC forms", () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  let c = parseCoord("3720N12150W"); assert.ok(near(c.lat, 37 + 20 / 60) && near(c.lon, -(121 + 50 / 60)));
  c = parseCoord("55N020W"); assert.ok(near(c.lat, 55) && near(c.lon, -20));
  c = parseCoord("5530N02000W"); assert.ok(near(c.lat, 55.5) && near(c.lon, -20));
  c = parseCoord("5020N"); assert.ok(near(c.lat, 50) && near(c.lon, -20));       // ARINC 424: N = north / west
  c = parseCoord("50N20"); assert.ok(near(c.lat, 50) && near(c.lon, -120));      // letter in the middle: longitude ≥ 100
  assert.equal(parseCoord("SAC"), null); assert.equal(parseCoord("V334"), null);
});

test("SkyVector-style route resolves endpoints, fixes and expands the airway", () => {
  const r = resolveRoute("KPAO SJC V334 SAC KTRK", lookups());
  assert.equal(r.from.icao, "KPAO"); assert.equal(r.to.icao, "KTRK");
  assert.equal(ids(r), "SJC X1 SAC");
  eq(r.points.map(p => p.via), [null, "V334", "V334"]);
  eq(r.skipped, []);
});

test("an ident with several matches picks the one nearest the previous point", () => {
  const r = resolveRoute("KPAO SAC KTRK", lookups());
  assert.equal(r.points[0].lat, 38.444);
});

test("a route without airports uses the planned departure and arrival", () => {
  const r = resolveRoute("SJC DCT SAC", lookups());
  assert.equal(r.from.icao, "KPAO"); assert.equal(r.to.icao, "KTRK"); assert.equal(ids(r), "SJC SAC");
});

test("airports at the ends override the planned ones", () => {
  const r = resolveRoute("KSQL OAK SAC KTRK", lookups());
  assert.equal(r.from.icao, "KSQL"); assert.equal(ids(r), "OAK SAC");
});

test("unknown fixes are skipped and reported, the rest still resolves", () => {
  const r = resolveRoute("KPAO SJC ZZZZQ SAC KTRK", lookups());
  assert.equal(ids(r), "SJC SAC");
  eq(r.skipped.map(s => [s.id, s.why]), [["ZZZZQ", "unknown"]]);
});

test("SID and STAR names are skipped as procedures", () => {
  const r = resolveRoute("KPAO SSTIK3 SJC SAC BDEGA3 KTRK", lookups());
  assert.equal(ids(r), "SJC SAC");
  eq(r.skipped.map(s => [s.id, s.why]), [["SSTIK3", "procedure"], ["BDEGA3", "procedure"]]);
});

test("an airway missing from the data flies direct to its exit fix", () => {
  const r = resolveRoute("KPAO OAK V999 SAC KTRK", lookups());
  assert.equal(ids(r), "OAK SAC");
  assert.equal(r.points[1].via, null);
  eq(r.skipped.map(s => [s.id, s.why]), [["V999", "airway"]]);
});

test("coordinates in the route become waypoints", () => {
  const r = resolveRoute("KPAO 3800N12100W KTRK", lookups());
  assert.equal(r.points.length, 1); assert.equal(r.points[0].kind, "coord"); assert.equal(r.points[0].lat, 38);
});

test("empty route gives no points and no error", () => {
  const r = resolveRoute("  ", lookups());
  assert.equal(r.points.length, 0); assert.equal(r.from.icao, "KPAO");
});

test("SimBrief OFP: header fields and navlog without TOC/TOD or the arrival airport", () => {
  const sb = parseSimbriefXML(readFileSync(new URL("./fixtures/simbrief-UNTT-UNEE.xml", import.meta.url), "utf8"));
  assert.equal(sb.dep, "UNTT"); assert.equal(sb.arr, "UNEE"); assert.equal(sb.altn, "UNNT");
  assert.equal(sb.acType, "PA24"); assert.equal(sb.initialAlt, 5000); assert.equal(sb.airac, "2610");
  assert.equal(sb.route, "NALE1E NALED NALE4B"); assert.equal(sb.etdMs, 1791861780000);
  eq(sb.points.map(p => p.id), ["DER21", "D152Z", "NALED", "D029G", "D042E", "CF23"]);
  assert.equal(sb.points[0].lat, 56.373769); assert.equal(sb.points[0].lon, 85.199403);
  assert.equal(sb.points[0].via, "NALE1E");
  assert.equal(sb.points[0].region, "UN"); assert.equal(sb.points[0].sidstar, true);
});

test("SimBrief OFP: consecutive duplicates collapse, oceanic lat/lon fixes stay", () => {
  const fix = (id, type, lat, lon) => `<fix><ident>${id}</ident><type>${type}</type><pos_lat>${lat}</pos_lat><pos_long>${lon}</pos_long><via_airway>DCT</via_airway></fix>`;
  const xml = `<OFP><origin><icao_code>EGLL</icao_code></origin><destination><icao_code>KJFK</icao_code></destination>
    <navlog>${fix("EGLL", "apt", 51.47, -0.46)}${fix("BAKUR", "wpt", 53, -15)}${fix("BAKUR", "wpt", 53, -15)}${fix("5530N", "ltlg", 55, -30)}${fix("TOD", "ltlg", 42, -70)}${fix("KJFK", "apt", 40.6, -73.8)}</navlog></OFP>`;
  const sb = parseSimbriefXML(xml);
  eq(sb.points.map(p => p.id), ["BAKUR", "5530N"]);
  assert.equal(sb.points[0].via, null);
});

test("SimBrief OFP: idents that aren't plain letters and digits are dropped", () => {
  const xml = `<OFP><origin><icao_code>EGLL</icao_code></origin><destination><icao_code>KJFK</icao_code></destination><navlog>
    <fix><ident>&lt;img src=x onerror=alert(1)&gt;</ident><type>wpt</type><pos_lat>52</pos_lat><pos_long>-10</pos_long></fix>
    <fix><ident>BAKUR</ident><type>wpt</type><pos_lat>53</pos_lat><pos_long>-15</pos_long></fix></navlog></OFP>`;
  eq(parseSimbriefXML(xml).points.map(p => p.id), ["BAKUR"]);
});

test("SimBrief error document throws its status message", () => {
  const xml = `<OFP><fetch><userid></userid><status>Error: Unknown UserID</status></fetch></OFP>`;
  assert.throws(() => parseSimbriefXML(xml), /Unknown UserID/);
  assert.throws(() => parseSimbriefXML("<html>nope</html>"), /SimBrief/);
});

// ---- SIDs / STARs named in the route that add nothing to draw (vector departures, arrivals flown from the chart)
const KSFO = { icao: "KSFO", lat: 37.619, lon: -122.375 }, KSEA = { icao: "KSEA", lat: 47.449, lon: -122.309 };

test("skipped procedures remember where they were in the route", () => {
  const r = resolveRoute("KPAO SSTIK3 SJC SAC BDEGA3 KTRK", lookups());
  eq(r.skipped.map(s => [s.id, s.at]), [["SSTIK3", 0], ["BDEGA3", 2]]);
});

test("a pasted route: the SID before the first point and the STAR after the last are reported, not drawn", () => {
  const r = resolveRoute("KPAO SSTIK3 SJC SAC BDEGA3 KTRK", lookups());
  eq(routeProcedures(r, APTS.KPAO, APTS.KTRK), [{ end: "dep", name: "SSTIK3", drawn: false }, { end: "arr", name: "BDEGA3", drawn: false }]);
});

test("a SimBrief plan: a SID whose only fix is on the airport is not drawn, a STAR with real fixes is", () => {
  const sb = { route: "GAPP7 SFO DCT DEDHD DCT RBL DCT LMT HAWKZ8", points: [
    { id: "SFO", lat: 37.6195, lon: -122.3739, via: "GAPP7", sidstar: true },
    { id: "DEDHD", lat: 38.3355, lon: -122.1128, via: null }, { id: "LMT", lat: 42.153, lon: -121.728, via: null },
    { id: "HAWKZ", lat: 46.2, lon: -122.0, via: "HAWKZ8", sidstar: true }, { id: "OLM", lat: 46.97, lon: -122.9, via: "HAWKZ8", sidstar: true }] };
  eq(routeProcedures({ sb, points: sb.points, skipped: [] }, KSFO, KSEA),
    [{ end: "dep", name: "GAPP7", drawn: false }, { end: "arr", name: "HAWKZ8", drawn: true }]);
});

test("no procedures named: nothing to report", () => {
  eq(routeProcedures(resolveRoute("KPAO SJC V334 SAC KTRK", lookups()), APTS.KPAO, APTS.KTRK), []);
});

test("the label claims radar vectors only when the FAA lists a conventional procedure with no fixes", () => {
  const faa = [{ code: "GAPP7.GAP", rnav: false, ends: [] }, { code: "SFO5.SFO", rnav: false, ends: [{ fix: "SFO" }] },
    { code: "TRUKN2.TRUKN", rnav: true, ends: [{ fix: "DEDHD" }] }];
  assert.equal(procedureLabel("GAPP7", faa), "GAPP7 · radar vectors");
  assert.equal(procedureLabel("SFO5", faa), "SFO5 · fly from chart");
  assert.equal(procedureLabel("NALE1E", null), "NALE1E · fly from chart");
  assert.equal(procedureLabel("<b>", null), "&lt;b&gt; · fly from chart");
});
