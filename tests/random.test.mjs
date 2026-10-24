// Unit tests for random.js (pure weather / sun functions; no DOM). Run: node --test tests/random.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";

// browser globals random.js expects: FT (feet -> metres, index.html) and basePerf (nav.js); tests swap basePerf
const ctx = vm.createContext({ FT: 0.3048, basePerf: () => ({}) });
vm.runInContext(readFileSync(new URL("../random.js", import.meta.url), "utf8"), ctx);
const { parseMetarCsv, parseTafXml, wxClass, tafAt, sunElevation, dayNight, aircraftLimits, estMinutes, generate } = ctx;
const gz = n => gunzipSync(readFileSync(new URL("./fixtures/" + n, import.meta.url))).toString("utf8");
const metarText = gz("awc-metars.csv.gz"), tafText = gz("awc-tafs.xml.gz");
const T = s => Date.parse(s);
// values built inside the vm realm have its Object prototype: compare as plain data
const plain = x => JSON.parse(JSON.stringify(x));

test("parses the METAR fixture", () => {
  const lines = metarText.split("\n").filter(l => l.trim());
  const obs = parseMetarCsv(metarText);
  assert.equal(obs.length, lines.length - 1);
  assert.ok(obs.length >= 250);
  for (const o of obs) {
    assert.ok(Number.isFinite(o.lat) && Number.isFinite(o.lon) && Number.isFinite(o.t), o.id);
    assert.ok(["VFR", "MVFR", "IFR", "LIFR", ""].includes(o.cat), o.id + " " + o.cat);
  }
  const unee = obs.find(o => o.id === "UNEE");
  assert.ok(unee);
  assert.equal(unee.wx, "SN");
  assert.equal(unee.vis, 0.99);
  assert.equal(unee.ceil, 900);
  assert.equal(unee.cat, "LIFR");
  assert.equal(unee.t, T("2026-10-24T22:17:00.000Z"));
  assert.equal(wxClass(unee).snow, true);
  assert.equal(wxClass(unee).lowvis, true);
  // newest observation in the fixture is the test clock T0
  assert.equal(Math.max(...obs.map(o => o.t)), T("2026-10-24T22:18:00.000Z"));
  // 10+ -> 10, clear sky -> no ceiling
  const kri = obs.find(o => o.id === "KRMY" || o.id === "KI69");
  if (kri) { assert.equal(kri.vis, 10); assert.equal(kri.ceil, null); assert.equal(kri.cat, "VFR"); }
  // quoted raw_text containing commas survives
  const q = obs.filter(o => o.raw.includes(","));
  assert.ok(q.length >= 1);
  for (const o of q) assert.ok(/^(METAR|SPECI)/.test(o.raw), o.raw);
  // the literal "null" flight category is replaced by a derived one (or "")
  assert.ok(!obs.some(o => o.cat === "null"));
});

test("METAR ceiling: lowest BKN/OVC/OVX base, vertical visibility, FEW/SCT ignored", () => {
  const hdr = "raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,corrected,auto,auto_station,maintenance_indicator_on,no_signal,lightning_sensor_off,freezing_rain_sensor_off,present_weather_sensor_off,wx_string,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,flight_category,three_hr_pressure_tendency_mb,maxT_c,minT_c,maxT24hr_c,minT24hr_c,precip_in,pcp3hr_in,pcp6hr_in,pcp24hr_in,snow_in,vert_vis_ft,metar_type,elevation_m";
  const row = (id, vis, sky, vv, cat) => {
    const c = new Array(44).fill("");
    c[0] = `"METAR ${id}"`; c[1] = id; c[2] = "2026-10-24T22:00:00.000Z"; c[3] = "10.0"; c[4] = "20.0"; c[10] = vis;
    sky.forEach((v, i) => { c[22 + i] = v; }); c[30] = cat; c[41] = vv; c[42] = "METAR";
    return c.join(",");
  };
  const text = "junk before header\n" + hdr + "\n" +
    row("AAAA", "10+", ["FEW", "500", "BKN", "2500", "OVC", "4000", "", ""], "", "MVFR") + "\n" +
    row("BBBB", "0.25", ["OVX", "100", "", "", "", "", "", ""], "1", "null") + "\n" +
    row("CCCC", "", ["SCT", "300", "", "", "", "", "", ""], "", "null") + "\n" +
    row("DDDD", "", ["", "", "", "", "", "", "", ""], "", "null") + "\n" +
    row("EEEE", "5", ["", "", "", "", "", "", "", ""], "8", "null") + "\n";
  const o = Object.fromEntries(parseMetarCsv(text).map(x => [x.id, x]));
  assert.equal(o.AAAA.ceil, 2500); assert.equal(o.AAAA.vis, 10); assert.equal(o.AAAA.cat, "MVFR");
  assert.equal(o.BBBB.ceil, 100); assert.equal(o.BBBB.vis, 0.25); assert.equal(o.BBBB.cat, "LIFR");
  assert.equal(o.CCCC.ceil, null); assert.equal(o.CCCC.vis, null); assert.equal(o.CCCC.cat, ""); // nothing known: no category
  assert.equal(o.DDDD.cat, "");
  assert.equal(o.EEEE.ceil, 800); // vertical visibility (hundreds of ft in the feed) counts as a ceiling
});

test("classifies weather groups", () => {
  const w = (wx, vis = 10, ceil = null, cat = "VFR") => wxClass({ wx, vis, ceil, cat });
  assert.deepEqual(plain(wxClass({ wx: "VCSH BR", vis: 5, ceil: 3000, cat: "MVFR" })), { snow: false, rain: false, lowvis: false });
  assert.equal(w("-SHSN").snow, true);
  assert.equal(w("-SHSN").rain, false);
  assert.equal(w("BLSN").snow, false);
  assert.equal(w("DRSN").snow, false);
  assert.equal(w("BLSN +SHSN").snow, true);
  const fz = w("-FZDZ");
  assert.equal(fz.rain, true); assert.equal(fz.snow, false);
  assert.equal(w("RERA").rain, false);
  assert.equal(w("VCSN").snow, false);
  assert.equal(w("TSRA").rain, true);
  assert.equal(w("+SHRA BR").rain, true);
  assert.equal(w("SG").snow, true);
  assert.equal(w("PL").snow, true);
  // mixed rain and snow anywhere in the report: snow, never rain
  for (const m of ["-RA -SN", "RA SN", "FZRA PL", "-RASN", "+RASN BR", "-SNRA", "-SN BR -RA"]) {
    assert.deepEqual(plain(w(m)).snow, true, m); assert.equal(w(m).rain, false, m);
  }
  assert.equal(w("-RA BLSN").rain, true); // blowing snow is not snow
  assert.equal(w("").rain, false);
  assert.equal(w(null).snow, false);
  assert.equal(wxClass({ wx: "", vis: 0.25, ceil: 200, cat: "LIFR" }).lowvis, true);
  assert.equal(wxClass({ wx: "", vis: 2, ceil: null, cat: "" }).lowvis, true);
  assert.equal(wxClass({ wx: "", vis: 10, ceil: 900, cat: "" }).lowvis, true);
  assert.equal(wxClass({ wx: "", vis: 3, ceil: 1000, cat: "MVFR" }).lowvis, false);
  assert.equal(wxClass({ wx: "", vis: null, ceil: null, cat: "IFR" }).lowvis, true);
});

test("reads a TAF at a time", () => {
  const tafs = parseTafXml(tafText);
  const taf = tafs.CYHK;
  assert.ok(taf);
  assert.equal(taf.id, "CYHK");
  assert.match(taf.raw, /^TAF AMD CYHK/);
  assert.equal(taf.from, T("2026-10-24T22:00:00Z"));
  assert.equal(taf.to, T("2026-10-25T06:00:00Z"));
  assert.equal(taf.fc.length, 4);
  assert.deepEqual(plain([...new Set(taf.fc.map(f => f.kind))].sort()), ["", "FM", "TEMPO"]);

  // base period 22Z-04Z (P6SM, OVC080) worsened by TEMPO 3SM -SN BR BKN006 at 01Z
  const a = tafAt(taf, T("2026-10-25T01:00:00Z"));
  assert.equal(wxClass(a).snow, true);
  assert.equal(a.vis, 3);
  assert.equal(a.ceil, 600);
  assert.equal(a.cat, "IFR");
  // FM 04Z (SCT004 OVC015) worsened by TEMPO 2SM -SN BR OVC004 at 05Z
  const c = tafAt(taf, T("2026-10-25T05:00:00Z"));
  assert.equal(c.vis, 2);
  assert.equal(c.ceil, 400);
  assert.equal(c.cat, "LIFR");
  assert.equal(wxClass(c).snow, true);
  // outside validity
  assert.equal(tafAt(taf, T("2026-10-24T21:59:00Z")), null);
  assert.equal(tafAt(taf, T("2026-10-25T06:00:00Z")), null);
  assert.equal(tafAt(taf, T("2026-10-26T00:00:00Z")), null);
});

test("TAF periods: FM replaces, BECMG overrides given elements, TEMPO/PROB only worsen", () => {
  const fc = (from, to, kind, o = {}) => ({ from: T(from), to: T(to), kind, wx: "", vis: null, ceil: null, sky: false, becoming: null, ...o });
  const taf = { id: "TEST", raw: "", from: T("2026-01-01T00:00Z"), to: T("2026-01-02T00:00Z"), fc: [
    fc("2026-01-01T12:00Z", "2026-01-02T00:00Z", "FM", { vis: 6, ceil: 800, sky: true, wx: "-RA" }),
    fc("2026-01-01T00:00Z", "2026-01-01T12:00Z", "", { vis: 10, ceil: 5000, sky: true }),
    fc("2026-01-01T06:00Z", "2026-01-01T12:00Z", "BECMG", { vis: 4, becoming: T("2026-01-01T08:00Z") }),
    fc("2026-01-01T18:00Z", "2026-01-01T20:00Z", "PROB", { vis: 1, wx: "+SN" }),
  ] };
  const at = s => tafAt(taf, T(s));
  const a = at("2026-01-01T05:00Z"); assert.equal(a.vis, 10); assert.equal(a.ceil, 5000); assert.equal(a.cat, "VFR");
  const b = at("2026-01-01T07:00Z"); assert.equal(b.vis, 10); // BECMG not yet complete
  const c = at("2026-01-01T09:00Z"); assert.equal(c.vis, 4); assert.equal(c.ceil, 5000); assert.equal(c.cat, "MVFR");
  const d = at("2026-01-01T13:00Z"); assert.equal(d.vis, 6); assert.equal(d.ceil, 800); assert.equal(d.cat, "IFR"); assert.equal(d.wx, "-RA");
  const e = at("2026-01-01T19:00Z"); assert.equal(e.vis, 1); assert.equal(e.ceil, 800); assert.equal(wxClass(e).snow, true); assert.equal(e.cat, "IFR");
});

test("merged TAF weather agrees with METAR rule: rain excludes snow", () => {
  const taf = { id: "T", raw: "", from: T("2026-01-01T00:00Z"), to: T("2026-01-02T00:00Z"), fc: [
    { from: T("2026-01-01T00:00Z"), to: T("2026-01-02T00:00Z"), kind: "", wx: "-SN", vis: 5, ceil: null, sky: true, becoming: null },
    { from: T("2026-01-01T02:00Z"), to: T("2026-01-01T04:00Z"), kind: "TEMPO", wx: "-RA", vis: null, ceil: null, sky: false, becoming: null }] };
  const a = tafAt(taf, T("2026-01-01T03:00Z"));
  assert.equal(wxClass(a).snow, true); assert.equal(wxClass(a).rain, false);
  // across the whole fixture no observation or forecast period reports both
  for (const o of parseMetarCsv(metarText)) { const k = wxClass(o); assert.ok(!(k.snow && k.rain), o.id); }
  for (const t of Object.values(parseTafXml(tafText))) for (const f of t.fc) {
    const k = wxClass(tafAt(t, Math.min(Math.max(f.from, t.from), t.to - 1))); assert.ok(!(k.snow && k.rain), t.id);
  }
});

test("parses the TAF fixture", () => {
  const tafs = parseTafXml(tafText);
  const ids = Object.keys(tafs);
  assert.equal(ids.length, 100);
  for (const id of ids) {
    const t = tafs[id];
    assert.equal(t.id, id);
    assert.ok(Number.isFinite(t.from) && Number.isFinite(t.to) && t.to > t.from, id);
    assert.ok(t.fc.length >= 1, id);
    for (const f of t.fc) {
      assert.ok(Number.isFinite(f.from) && Number.isFinite(f.to), id);
      assert.ok(["FM", "BECMG", "TEMPO", "PROB", ""].includes(f.kind), id + f.kind);
    }
    assert.ok(tafAt(t, t.from), id);
  }
  // PROB (change_indicator or <probability>) and BECMG both appear
  assert.ok(ids.some(id => tafs[id].fc.some(f => f.kind === "PROB")));
  assert.ok(tafs.CYBW.fc.some(f => f.kind === "BECMG"));
  assert.ok(tafs.CYBW.fc.some(f => f.vis === 6));
});

test("TAF XML: vertical visibility (feet), <probability> as PROB, CDATA raw", () => {
  const xml = `<response><data><TAF><raw_text><![CDATA[TAF XXXX 010000Z 0100/0112 3SM BR]]></raw_text><station_id>XXXX</station_id>` +
    `<issue_time>2026-01-01T00:00:00.000Z</issue_time><valid_time_from>2026-01-01T00:00:00.000Z</valid_time_from><valid_time_to>2026-01-01T12:00:00.000Z</valid_time_to>` +
    `<forecast><fcst_time_from>2026-01-01T00:00:00.000Z</fcst_time_from><fcst_time_to>2026-01-01T12:00:00.000Z</fcst_time_to><visibility_statute_mi>6+</visibility_statute_mi><sky_condition sky_cover="CLR"/></forecast>` +
    `<forecast><fcst_time_from>2026-01-01T02:00:00.000Z</fcst_time_from><fcst_time_to>2026-01-01T04:00:00.000Z</fcst_time_to><change_indicator>TEMPO</change_indicator><probability>30</probability><visibility_statute_mi>0.31</visibility_statute_mi><vert_vis_ft>100</vert_vis_ft><wx_string>-RA FG</wx_string><sky_condition sky_cover="OVX"/></forecast>` +
    `<forecast><fcst_time_from>2026-01-01T06:00:00.000Z</fcst_time_from><fcst_time_to>2026-01-01T08:00:00.000Z</fcst_time_to><probability>40</probability><sky_condition sky_cover="BKN" cloud_base_ft_agl="400"/></forecast>` +
    `</TAF></data></response>`;
  const t = parseTafXml(xml).XXXX;
  assert.equal(t.raw, "TAF XXXX 010000Z 0100/0112 3SM BR");
  assert.deepEqual(plain(t.fc.map(f => f.kind)), ["", "PROB", "PROB"]);
  const a = tafAt(t, T("2026-01-01T03:00Z"));
  assert.equal(a.ceil, 100); assert.equal(a.vis, 0.31); assert.equal(a.cat, "LIFR"); assert.equal(wxClass(a).rain, true);
  const b = tafAt(t, T("2026-01-01T07:00Z"));
  assert.equal(b.vis, 6); assert.equal(b.ceil, 400); assert.equal(b.cat, "LIFR");
  const c = tafAt(t, T("2026-01-01T10:00Z"));
  assert.equal(c.cat, "VFR"); assert.equal(c.ceil, null);
});

test("sun elevation", () => {
  assert.ok(sunElevation(37.62, -122.38, T("2026-06-21T20:00:00Z")) > 70);
  assert.ok(sunElevation(37.62, -122.38, T("2026-06-21T08:00:00Z")) < -6);
  // equinox noon on the equator at the prime meridian: sun nearly overhead
  assert.ok(sunElevation(0, 0, T("2026-03-20T12:00:00Z")) > 85);
  // polar night / midnight sun
  assert.ok(sunElevation(80, 0, T("2026-12-21T12:00:00Z")) < -6);
  assert.ok(sunElevation(80, 0, T("2026-06-21T00:00:00Z")) > 0);
  assert.equal(dayNight(-3), "twilight");
  assert.equal(dayNight(-6), "twilight");
  assert.equal(dayNight(-6.1), "night");
  assert.equal(dayNight(0), "twilight");
  assert.equal(dayNight(0.1), "day");
  assert.equal(dayNight(45), "day");
});

/* ---------------------------------------------------------------- screening and generation */
const NOW = T("2026-10-24T22:18:00.000Z");   // fixture clock T0; ETD = 22:20Z
const ETD = T("2026-10-24T22:20:00.000Z");
function seeded(a) { return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gcNm = (a, b) => {
  const r = Math.PI / 180, dla = (b.lat - a.lat) * r, dlo = (b.lon - a.lon) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlo / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
};
const apt = (icao, lat, lon, alt = 0) => ({ icao, name: icao + " Field", lat, lon, alt });
const ob = (a, wx, o = {}) => ({ id: a.icao, lat: a.lat, lon: a.lon, t: NOW - 20 * 60000, raw: `METAR ${a.icao} ${wx || "CAVOK"}`, wx,
  vis: 10, ceil: null, cat: "VFR", ...o });
const SNOW = { vis: 2, ceil: 800, cat: "IFR" };
// 5 sites 3 deg of longitude apart at 45N (~127 NM), each with a twin field 0.4 deg east (~17 NM)
function baseWorld() {
  const airports = [];
  for (let s = 0; s < 5; s++) airports.push(apt("ST" + s + "A", 45, 3 * s), apt("ST" + s + "B", 45, 3 * s + 0.4));
  const rwy = Object.fromEntries(airports.map(a => [a.icao, [8000, 8000, 1]]));
  return { airports, rwy };
}
const GA = { kt: 120, rangeNM: 400, minRwyFt: 2000, paved: false };
const run = (w, prompts, seed, extra = {}) =>
  plain(generate({ obs: [], tafs: {}, lim: GA, now: NOW, rand: seeded(seed), ...w, prompts, ...extra }));
const P = (time, dep, arr, dist) => ({ time, dep, arr, dist });
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

test("estMinutes adds 15 minutes to the cruise time", () => {
  assert.equal(estMinutes(120, 120), 75);
  assert.equal(estMinutes(0, 300), 15);
  assert.equal(typeof vm.runInContext("RandomFlight.now()", ctx), "number");
  assert.ok(Math.abs(vm.runInContext("RandomFlight.now()", ctx) - Date.now()) < 1000);
});

test("aircraftLimits from model data", () => {
  ctx.basePerf = () => ({ to: 2000, ldg: 1500, sfTo: 1.15, sfLdg: 1.67 });
  const a = plain(aircraftLimits({ kind: "openap", cruiseMach: 0.78, ac: { cruise: { range: 5000 } } }));
  assert.ok(Math.abs(a.kt - 0.78 * 573) < 1e-9);
  assert.ok(Math.abs(a.rangeNM - 5000 / 1.852 * 0.9) < 1e-9);
  assert.ok(Math.abs(a.minRwyFt - 1500 * 1.67 / 0.3048) < 1e-9);
  assert.equal(a.paved, true);
  ctx.basePerf = () => ({ to: 500, ldg: 400, sfTo: 1.33, sfLdg: 1.43 });
  const g = plain(aircraftLimits({ kind: "apm", P: { cruiseTAS: 120, cruiseRange: 600 } }));
  assert.equal(g.kt, 120);
  assert.equal(g.rangeNM, 600 - 120 * 0.75); // 45-min reserve
  assert.ok(Math.abs(g.minRwyFt - 500 * 1.33 / 0.3048) < 1e-9);
  assert.equal(g.paved, false);
  ctx.basePerf = () => ({});
});

test("falls back when the aircraft lacks data", () => {
  ctx.basePerf = () => ({});
  assert.deepEqual(plain(aircraftLimits({ kind: "apm", P: {} })), { kt: 110, rangeNM: 300, minRwyFt: 2500, paved: false });
  assert.deepEqual(plain(aircraftLimits({ kind: "openap", ac: {} })), { kt: 110, rangeNM: 300, minRwyFt: 6000, paved: true });
  // only one of the two distances known: never below the conservative default
  ctx.basePerf = () => ({ to: 300, sfTo: 1.33 });
  assert.equal(aircraftLimits({ kind: "apm", P: { cruiseTAS: 100 } }).minRwyFt, 2500);
  ctx.basePerf = () => ({});
});

test("returns 5 full matches when the world has them", () => {
  const w = baseWorld();
  w.obs = w.airports.map(a => ob(a, "-SN", SNOW));
  for (const seed of SEEDS) {
    const o = run(w, P("night", "snow", "snow", "short"), seed);
    assert.equal(o.length, 5, "seed " + seed);
    for (const x of o) {
      assert.deepEqual(x.misses, [], "seed " + seed);
      assert.equal(x.light, "night");
      assert.equal(x.depWx.id, x.dep.icao);
      assert.equal(x.arrWx.src, "metar");
      assert.ok(w.airports.some(a => a.icao === x.arr.icao && a.name === x.arr.name));
    }
    // variety: distinct departures, all at least 100 NM apart (one per site is possible here)
    assert.equal(new Set(o.map(x => x.dep.icao)).size, 5);
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert.ok(gcNm(o[i].dep, o[j].dep) >= 100, "seed " + seed);
  }
});

test("never pairs an airport with itself or a field within 5 NM", () => {
  const w = baseWorld();
  // the same field under a second ident, 3 NM away (a 30-kt aircraft would make it a 21-minute "flight")
  w.airports.push(apt("XS0A", 45, 0.07)); w.rwy.XS0A = [8000, 8000, 1];
  const slow = { kt: 30, rangeNM: 200, minRwyFt: 2000, paved: false };
  for (const seed of SEEDS) for (const o of run(w, P("any", "any", "any", "any"), seed, { lim: slow })) {
    assert.notEqual(o.dep.icao, o.arr.icao);
    assert.ok(gcNm(o.dep, o.arr) > 5, o.dep.icao + "-" + o.arr.icao);
    assert.ok(o.nm > 5);
  }
  const pair = { airports: [apt("AAAA", 45, 0), apt("BBBB", 45, 0.07)], rwy: { AAAA: [8000, 8000, 1], BBBB: [8000, 8000, 1] } };
  assert.deepEqual(run(pair, P("any", "any", "any", "any"), 1, { lim: slow }), []);
});

test("respects the runway rule", () => {
  const w = baseWorld();
  const add = (a, r) => { w.airports.push(a); w.rwy[a.icao] = r; };
  add(apt("PAV5", 45, 1.5), [5000, 5000, 1]);        // paved, too short
  add(apt("GRV9", 45, 4.5), [9000, 0, 0]);           // long, but gravel
  add(apt("HIG7", 45, 7.5, 5500), [7000, 7000, 1]);  // long enough at sea level, not at 5,500 ft
  add(apt("HIGX", 45, 10.5, 5500), [10100, 10100, 1]); // 6500 x 1.55 = 10,075 ft: just enough
  w.airports.push(apt("NORW", 45, 6)); // not in the runway index
  const a320 = { kt: 450, rangeNM: 3000, minRwyFt: 6500, paved: true };
  const seen = new Set();
  for (const seed of SEEDS) for (const o of run(w, P("any", "any", "any", "any"), seed, { lim: a320 })) {
    for (const id of [o.dep.icao, o.arr.icao]) { assert.ok(!["PAV5", "GRV9", "HIG7", "NORW"].includes(id), id); seen.add(id); }
  }
  assert.ok(seen.has("HIGX"));
  // a GA aircraft may use the gravel strip (longest runway of any surface)
  const ga = new Set();
  for (const seed of SEEDS) for (const o of run(w, P("any", "any", "any", "any"), seed, { lim: { ...GA, kt: 300, rangeNM: 1000 } })) ga.add(o.dep.icao).add(o.arr.icao);
  assert.ok(ga.has("GRV9") && ga.has("PAV5") && !ga.has("NORW"));
});

test("distance bands", () => {
  const w = baseWorld();
  for (const seed of SEEDS) {
    const s = run(w, P("any", "any", "any", "short"), seed);
    assert.equal(s.length, 5);
    for (const o of s) {
      assert.deepEqual(o.misses, []);
      assert.ok(o.min >= 20 && o.min <= 120, "short " + o.min);
      assert.ok(Math.abs(o.min - estMinutes(o.nm, 120)) <= 1);
    }
    const l = run(w, P("any", "any", "any", "long"), seed);
    assert.equal(l.length, 5);
    for (const o of l) { assert.deepEqual(o.misses, []); assert.ok(o.min > 120, "long " + o.min); assert.ok(o.nm <= 400, "range " + o.nm); }
    for (const o of run(w, P("any", "any", "any", "any"), seed)) { assert.ok(o.min >= 20); assert.ok(o.nm <= 400); }
  }
  // near misses on distance, labelled with the estimated time
  const two = (lonB) => ({ airports: [apt("AAAA", 45, 0), apt("BBBB", 45, lonB)], rwy: { AAAA: [8000, 8000, 1], BBBB: [8000, 8000, 1] } });
  const hm = m => Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0");
  const over = run(two(6), P("any", "any", "any", "short"), 1); // ~254 NM: 2 h 22
  assert.equal(over.length, 2);
  for (const o of over) { assert.ok(o.min > 120); assert.deepEqual(o.misses, [hm(o.min) + " — just over short"]); }
  const under = run(two(4.5), P("any", "any", "any", "long"), 1); // ~191 NM: 1 h 50
  assert.equal(under.length, 2);
  for (const o of under) { assert.ok(o.min <= 120); assert.deepEqual(o.misses, [hm(o.min) + " — under long"]); }
  // beyond the range there is nothing, not even a near miss
  assert.deepEqual(run(two(10), P("any", "any", "any", "long"), 1), []); // ~424 NM > 400
});

// longitude on the equator where the sun stands at `elev` degrees at ETD (sun sinking eastward of ~-60 deg here)
function lonAtElev(elev) {
  let a = -90, b = -30;
  for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (sunElevation(0, m, ETD) > elev) a = m; else b = m; }
  return (a + b) / 2;
}

test("night needs real darkness", () => {
  const tw = apt("TWIL", 0, lonAtElev(-3)), dk = apt("DARK", 0, lonAtElev(-15));
  const airports = [tw, dk, apt("TWN1", 1, tw.lon), apt("TWS1", -1, tw.lon), apt("DKN1", 1, dk.lon), apt("DKS1", -1, dk.lon)];
  const w = { airports, rwy: Object.fromEntries(airports.map(a => [a.icao, [8000, 8000, 1]])), obs: [ob(tw, ""), ob(dk, "")] };
  assert.ok(Math.abs(sunElevation(tw.lat, tw.lon, ETD) + 3) < 0.01);
  for (const seed of SEEDS) {
    const o = run(w, P("night", "any", "any", "short"), seed);
    assert.equal(o.length, 2); // departures need a report when a time is asked for
    assert.equal(o[0].dep.icao, "DARK"); assert.deepEqual(o[0].misses, []); assert.equal(o[0].light, "night");
    assert.equal(o[1].dep.icao, "TWIL"); assert.deepEqual(o[1].misses, ["twilight, not dark yet"]); assert.equal(o[1].light, "twilight");
  }
  const d = run(w, P("day", "any", "any", "short"), 1);
  assert.deepEqual(d.find(x => x.dep.icao === "TWIL").misses, ["twilight, not full daylight"]);
});

test("uses the TAF beyond 90 minutes", () => {
  const dep = apt("DEPT", 45, 0), near = apt("NEAR", 45, 3), far = apt("FARR", 45, 6); // ~127 NM (79 min), ~254 NM (142 min)
  const airports = [dep, near, far];
  const rwy = Object.fromEntries(airports.map(a => [a.icao, [8000, 8000, 1]]));
  const obs = [ob(dep, "-SN", SNOW), ob(near, "-RA"), ob(far, "")]; // the METAR at FARR shows no rain
  const taf = { id: "FARR", raw: "TAF FARR 242200Z 2422/2522 5SM -RA OVC020", from: NOW - 3600000, to: NOW + 86400000,
    fc: [{ from: NOW - 3600000, to: NOW + 86400000, kind: "", wx: "-RA", vis: 5, ceil: 2000, sky: true, becoming: null }] };
  const w = { airports, rwy, obs, tafs: { FARR: taf } };
  for (const seed of SEEDS) {
    const all = run(w, P("any", "snow", "rain", "long"), seed), o = all[0];
    assert.equal(o.dep.icao, "DEPT"); assert.equal(o.arr.icao, "FARR"); assert.ok(o.min > 90);
    assert.deepEqual(o.misses, []);
    assert.equal(o.arrWx.src, "taf"); assert.equal(o.arrWx.raw, taf.raw); assert.equal(o.arrWx.wx, "-RA"); assert.equal(o.arrWx.cat, "MVFR");
    assert.ok(all.slice(1).every(x => x.misses.length > 0)); // the other reporting fields are near misses (no snow)
    for (const x of run(w, P("any", "any", "any", "any"), seed)) {
      if (x.arrWx) assert.equal(x.arrWx.src, x.min > 90 ? "taf" : "metar");
      else assert.ok(x.min > 90 && x.arr.icao !== "FARR"); // only a far field without a TAF has no arrival weather
    }
  }
  // without a TAF, a far arrival has no report even though it has a METAR
  const n = run({ ...w, tafs: {} }, P("any", "snow", "rain", "long"), 1);
  assert.equal(n[0].dep.icao, "DEPT"); assert.equal(n[0].arr.icao, "FARR");
  assert.deepEqual(n[0].misses, ["no report at arrival"]); assert.equal(n[0].arrWx, null);
});

test("stale reports are ignored", () => {
  const w = baseWorld();
  const stale = w.airports[4]; // ST2A
  w.obs = w.airports.map(a => ob(a, "-SN", a === stale ? { ...SNOW, t: NOW - 2 * 3600000, raw: "METAR STALE" } : SNOW));
  let n = 0;
  for (const seed of SEEDS) for (const o of run(w, P("any", "snow", "any", "short"), seed)) {
    assert.notEqual(o.dep.icao, stale.icao);
    assert.notEqual(o.arrWx && o.arrWx.raw, "METAR STALE");
    n++;
  }
  assert.ok(n >= 5 * SEEDS.length);
});

test("fills with near misses, labelled", () => {
  const w = baseWorld();
  w.obs = w.airports.map(a => ob(a, "RA"));
  for (const seed of SEEDS) {
    const o = run(w, P("any", "snow", "any", "short"), seed);
    assert.equal(o.length, 5);
    for (const x of o) assert.ok(x.misses.includes("rain instead of snow"), JSON.stringify(x.misses));
    assert.equal(new Set(o.map(x => x.dep.icao)).size, 5);
  }
  // full matches first, then near misses by fewest misses
  w.obs = w.airports.map((a, i) => ob(a, i === 0 || i === 6 ? "-SN" : i % 2 ? "" : "RA", i === 0 || i === 6 ? SNOW : {}));
  for (const seed of SEEDS) {
    const o = run(w, P("any", "snow", "snow", "short"), seed);
    assert.equal(o.length, 5);
    for (let i = 1; i < o.length; i++) assert.ok(o[i - 1].misses.length <= o[i].misses.length);
    assert.ok(o[0].misses.length <= 1);
    for (const x of o) for (const m of x.misses)
      assert.ok(/^(rain|low visibility|no precipitation) instead of snow$/.test(m), m);
  }
});

test("low visibility wanted at a clear field: the note says good visibility", () => {
  const w = baseWorld();
  w.obs = w.airports.map(a => ob(a, ""));
  for (const seed of SEEDS) {
    const o = run(w, P("any", "lowvis", "any", "short"), seed);
    assert.equal(o.length, 5);
    for (const x of o) assert.deepEqual(x.misses, ["good visibility instead of low visibility"]);
  }
});

test("generate stays well under a second on a worldwide data set", () => {
  // synthetic world the size of the real one: 49k airports, ~5k reports, 1k TAFs
  const rnd = seeded(42), airports = [], rwy = {}, obs = [], tafs = {};
  const WX = ["-SN", "SN", "RA", "-RA", "-SHRA", "BR", "FG", "", "", "", "", "", "", "", "", "", "", "", "", ""];
  for (let i = 0; i < 49000; i++) {
    const a = apt("W" + i, -60 + rnd() * 130, -180 + rnd() * 360, Math.round(rnd() * 3000));
    airports.push(a); rwy[a.icao] = [Math.round(1500 + rnd() * 11000), rnd() < 0.5 ? Math.round(2000 + rnd() * 10000) : 0, 1];
    if (i < 5100) {
      const wx = WX[Math.floor(rnd() * WX.length)], low = wx === "FG" || rnd() < 0.1;
      obs.push(ob(a, wx, { t: NOW - rnd() * 150 * 60000, ...(low ? SNOW : {}) }));
    }
    if (i < 1000) tafs[a.icao] = { id: a.icao, raw: "TAF " + a.icao, from: NOW - 3600000, to: NOW + 86400000,
      fc: [{ from: NOW - 3600000, to: NOW + 86400000, kind: "", wx: WX[i % WX.length], vis: 6, ceil: null, sky: true, becoming: null },
        { from: NOW + 3600000, to: NOW + 7200000, kind: "TEMPO", wx: "-SN", vis: 2, ceil: 700, sky: true, becoming: null }] };
  }
  const liner = { kt: 470, rangeNM: 6000, minRwyFt: 7000, paved: true };
  const cases = [[GA, P("any", "any", "any", "any")], [GA, P("night", "snow", "snow", "long")], [GA, P("day", "rain", "lowvis", "short")],
    [liner, P("any", "snow", "snow", "any")], [liner, P("night", "lowvis", "snow", "long")], [liner, P("any", "any", "any", "short")]];
  for (const [lim, prompts] of cases) {
    const t0 = performance.now();
    const o = generate({ airports, rwy, obs, tafs, lim, prompts, now: NOW, rand: seeded(7) });
    const ms = performance.now() - t0;
    assert.equal(o.length, 5, JSON.stringify(prompts));
    assert.ok(ms < 1000, `${JSON.stringify(prompts)}: ${ms.toFixed(0)} ms`);
  }
});
