"use strict";
/* =====================================================================
   Random flight generator. This first section has no DOM, so it can be unit-tested
   (tests/random.test.mjs, loaded with node:vm):
     parseMetarCsv  – aviationweather.gov metars cache CSV -> observations
     parseTafXml    – aviationweather.gov tafs cache XML   -> TAF per station
     wxClass        – snow / rain / low-visibility flags from a weather group
     tafAt          – the forecast conditions at one moment
     sunElevation   – NOAA simplified solar position; dayNight names it
   ===================================================================== */

// flight category, same rule as flightCat in charts.js ("" when neither value is known)
function randFlightCat(vis, ceil) {
  if (vis == null && ceil == null) return "";
  if ((ceil != null && ceil < 500) || (vis != null && vis < 1)) return "LIFR";
  if ((ceil != null && ceil < 1000) || (vis != null && vis < 3)) return "IFR";
  if ((ceil != null && ceil <= 3000) || (vis != null && vis <= 5)) return "MVFR";
  return "VFR";
}

// statute-mile visibility as the files print it: "10+", "6+", "0.25", "3.73" (empty -> null)
function randVis(s) {
  const v = parseFloat(String(s == null ? "" : s).replace("+", ""));
  return Number.isFinite(v) ? v : null;
}

// RFC 4180 reader: quoted fields may hold commas, doubled quotes and line breaks
function randParseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const RAND_CEIL_COVER = { BKN: 1, OVC: 1, OVX: 1 };

function parseMetarCsv(text) {
  const m = /^raw_text/m.exec(text);
  if (!m) return [];
  const rows = randParseCsv(text.slice(m.index));
  const hdr = rows[0];
  const col = n => hdr.indexOf(n);
  const iId = col("station_id"), iT = col("observation_time"), iLat = col("latitude"), iLon = col("longitude");
  const iVis = col("visibility_statute_mi"), iWx = col("wx_string"), iCat = col("flight_category"), iVv = col("vert_vis_ft");
  const sky = []; // the four repeated sky_cover / cloud_base_ft_agl pairs, by column index
  hdr.forEach((h, i) => { if (h === "sky_cover") sky.push(i); });
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    if (c.length < 5) continue;
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]), t = Date.parse(c[iT]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
    let ceil = null;
    for (const i of sky) {
      const b = parseFloat(c[i + 1]);
      if (RAND_CEIL_COVER[c[i]] && Number.isFinite(b) && (ceil == null || b < ceil)) ceil = b;
    }
    // vert_vis_ft is in hundreds of feet in this feed (OVX 500 comes with vert_vis_ft 5)
    const vv = c[iVv] === "" || c[iVv] == null ? NaN : parseFloat(c[iVv]) * 100;
    if (Number.isFinite(vv) && (ceil == null || vv < ceil)) ceil = vv;
    const vis = randVis(c[iVis]);
    // the feed prints a literal "null" when it has no category: derive one from vis / ceiling instead
    const cat = ["VFR", "MVFR", "IFR", "LIFR"].includes(c[iCat]) ? c[iCat] : randFlightCat(vis, ceil);
    out.push({ id: c[iId], lat, lon, t, raw: c[0], wx: (c[iWx] || "").trim(), vis, ceil, cat });
  }
  return out;
}

function wxClass(o) {
  let snow = false, rain = false;
  for (const tok of String((o && o.wx) || "").split(/\s+/)) {
    if (!tok || tok.startsWith("VC") || tok.startsWith("RE")) continue;
    const w = tok.replace(/^[-+]/, "");
    if ((w.includes("SN") || w.includes("SG") || w.includes("PL")) && w !== "BLSN" && w !== "DRSN") snow = true;
    else if (w.includes("RA") || w.includes("DZ")) rain = true;
  }
  const cat = (o && o.cat) || "";
  const lowvis = cat === "IFR" || cat === "LIFR" || (o.vis != null && o.vis < 3) || (o.ceil != null && o.ceil < 1000);
  return { snow, rain, lowvis };
}

function parseTafXml(text) {
  const tag = (s, n) => { const m = new RegExp("<" + n + ">([\\s\\S]*?)</" + n + ">").exec(s); return m ? m[1] : null; };
  const out = {}, issued = {};
  const blockRe = /<TAF>([\s\S]*?)<\/TAF>/g;
  let b;
  while ((b = blockRe.exec(text))) {
    const x = b[1];
    const id = (tag(x, "station_id") || "").trim();
    const from = Date.parse(tag(x, "valid_time_from")), to = Date.parse(tag(x, "valid_time_to"));
    if (!id || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    const iss = Date.parse(tag(x, "issue_time")) || 0;
    if (out[id] && issued[id] > iss) continue; // keep the newest bulletin per station
    const raw = (/<raw_text>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/raw_text>/.exec(x) || [])[1] || "";
    const fc = [];
    const fRe = /<forecast>([\s\S]*?)<\/forecast>/g;
    let f;
    while ((f = fRe.exec(x))) {
      const y = f[1];
      const ff = Date.parse(tag(y, "fcst_time_from")), ft = Date.parse(tag(y, "fcst_time_to"));
      if (!Number.isFinite(ff) || !Number.isFinite(ft)) continue;
      let kind = (tag(y, "change_indicator") || "").trim();
      if (!["FM", "BECMG", "TEMPO", "PROB"].includes(kind)) kind = "";
      if (tag(y, "probability") != null && (kind === "" || kind === "TEMPO")) kind = "PROB";
      let ceil = null, hasSky = false, m;
      const sRe = /<sky_condition\b([^>]*)>/g;
      while ((m = sRe.exec(y))) {
        hasSky = true;
        const cover = (/sky_cover="(\w+)"/.exec(m[1]) || [])[1], base = parseFloat((/cloud_base_ft_agl="([\d.]+)"/.exec(m[1]) || [])[1]);
        if (RAND_CEIL_COVER[cover] && Number.isFinite(base) && (ceil == null || base < ceil)) ceil = base;
      }
      const vv = parseFloat(tag(y, "vert_vis_ft"));
      if (Number.isFinite(vv)) { hasSky = true; if (ceil == null || vv < ceil) ceil = vv; }
      const becoming = Date.parse(tag(y, "time_becoming"));
      fc.push({ from: ff, to: ft, kind, wx: (tag(y, "wx_string") || "").trim(), vis: randVis(tag(y, "visibility_statute_mi")),
        ceil, sky: hasSky, becoming: Number.isFinite(becoming) ? becoming : null });
    }
    out[id] = { id, raw, from, to, fc }; issued[id] = iss;
  }
  return out;
}

// Conditions forecast for moment t: the prevailing period (base, then FM / BECMG in time order), worsened by any
// TEMPO / PROB period that covers t. A BECMG only overrides the elements it states and counts once it has completed
// (time_becoming). null when t is outside the TAF's validity.
function tafAt(taf, t) {
  if (!taf || !(t >= taf.from && t < taf.to)) return null;
  const rank = { "": 0, FM: 1, BECMG: 2 };
  const start = g => (g.kind === "BECMG" && g.becoming != null ? g.becoming : g.from);
  const prev = taf.fc.filter(g => g.kind in rank).sort((a, b) => start(a) - start(b) || rank[a.kind] - rank[b.kind]);
  let wx = "", vis = null, ceil = null;
  for (const g of prev) {
    if (start(g) > t) break;
    if (g.kind === "BECMG") {
      if (g.vis != null) vis = g.vis;
      if (g.sky) ceil = g.ceil;
      if (g.wx || g.vis != null || g.sky) wx = g.wx;
    } else { wx = g.wx; vis = g.vis; ceil = g.ceil; }
  }
  const toks = wx ? wx.split(/\s+/) : [];
  for (const g of taf.fc) {
    if (g.kind !== "TEMPO" && g.kind !== "PROB") continue;
    if (!(g.from <= t && t < g.to)) continue;
    if (g.vis != null && (vis == null || g.vis < vis)) vis = g.vis;
    if (g.ceil != null && (ceil == null || g.ceil < ceil)) ceil = g.ceil;
    for (const k of g.wx ? g.wx.split(/\s+/) : []) if (!toks.includes(k)) toks.push(k);
  }
  return { wx: toks.join(" "), vis, ceil, cat: randFlightCat(vis, ceil) };
}

// Sun elevation above the horizon in degrees (NOAA general solar position, no refraction; well inside 1 degree).
function sunElevation(lat, lon, t) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const jd = t / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M * rad) * 0.000289;
  const om = 125.04 - 1934.136 * T;
  const lam = L0 + C - 0.00569 - 0.00478 * Math.sin(om * rad);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(om * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lam * rad));
  const y = Math.tan(eps * rad / 2) ** 2;
  const eqt = 4 * deg * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad) + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad)
    - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M * rad));
  const minutes = ((t / 60000) % 1440 + 1440) % 1440;
  const tst = (((minutes + eqt + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * rad;
  const la = lat * rad;
  return Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha)) * deg;
}

function dayNight(elev) { return elev > 0 ? "day" : elev < -6 ? "night" : "twilight"; }
