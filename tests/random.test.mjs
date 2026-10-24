// Unit tests for random.js (pure weather / sun functions; no DOM). Run: node --test tests/random.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../random.js", import.meta.url), "utf8"), ctx);
const { parseMetarCsv, parseTafXml, wxClass, tafAt, sunElevation, dayNight } = ctx;
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
