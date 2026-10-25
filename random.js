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
  // report-level: any snow token makes the whole report snow, and rain is only reported when there is no snow
  let snow = false, wet = false;
  for (const tok of String((o && o.wx) || "").split(/\s+/)) {
    if (!tok || tok.startsWith("VC") || tok.startsWith("RE")) continue;
    const w = tok.replace(/^[-+]/, "");
    if ((w.includes("SN") || w.includes("SG") || w.includes("PL")) && w !== "BLSN" && w !== "DRSN") snow = true;
    else if (w.includes("RA") || w.includes("DZ")) wet = true;
  }
  const rain = wet && !snow;
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
// TEMPO / PROB period that covers t. A BECMG only overrides the elements it states (NSW: no significant weather) and
// counts once it has completed (time_becoming). null when t is outside the TAF's validity.
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
      if (g.wx) wx = g.wx === "NSW" ? "" : g.wx;
    } else { wx = g.wx === "NSW" ? "" : g.wx; vis = g.vis; ceil = g.ceil; }
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

/* =====================================================================
   Screening and generation (pure: the clock comes in as input.now, randomness as input.rand)
     aircraftLimits – cruise speed, range and runway need of a model (browser glue: basePerf, FT)
     estMinutes     – screening flight time
     generate       – up to 5 options: full matches first, then near misses labelled with what differs
   ===================================================================== */

const RandomFlight = { now: () => Date.now(), rand: Math.random }; // the UI reads the clock and randomness here, so tests can pin them

function aircraftLimits(m) {
  const oap = m.kind === "openap", P = m.P || {};
  const kt = (oap ? m.cruiseMach * 573 : P.cruiseTAS) || 110;
  const km = oap && m.ac && m.ac.cruise ? m.ac.cruise.range : null;
  // airliners: 90 % of the OpenAP cruise range; GA: published range less a 45-minute reserve
  const rangeNM = oap ? (km ? km / 1.852 * 0.9 : 300) : P.cruiseRange ? P.cruiseRange - kt * 0.75 : 300;
  const b = basePerf(m) || {};
  const dflt = oap ? 6000 : 2500; // a distance missing from the model: never screen below this
  const ft = x => x / FT;
  let minRwyFt;
  if (oap) {
    // Airliners are screened on the takeoff requirement only: the OpenAP WRAP landing figure (observed braking
    // distance + 300 m, x1.67) is far above real landing field lengths (B789 ~15,000 ft) and would leave only a
    // couple of airports in the world. The planned flight still runs the landing checks.
    minRwyFt = b.to > 0 ? ft(b.to * (b.sfTo || 1)) : dflt;
  } else {
    // GA: the larger of takeoff and landing from the POH data
    const need = [b.to * (b.sfTo || 1), b.ldg * (b.sfLdg || 1)].filter(x => x > 0).map(ft);
    minRwyFt = need.length === 2 ? Math.max(...need) : Math.max(dflt, ...need);
  }
  return { kt, rangeNM, minRwyFt, paved: oap || m.engineKind === "jet" };
}

function estMinutes(nm, kt) { return nm / kt * 60 + 15; } // + climb, descent and taxi

const RAND_NM = 3440.065, RAND_FRESH = 90 * 60000, RAND_COUNT = 5, RAND_SPACING = 100, RAND_WORK = 2e6;
const RAND_WORD = { snow: "snow", rain: "rain", lowvis: "low visibility" };
const RAND_ICAO = /^[A-Z]{4}$/, RAND_MIL = /\bAir Base\b|\bAFB\b/i;

function randHm(min) { return Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0"); }

// null when weather w has the wanted condition, else "<got> instead of <wanted>"
function randWxMiss(want, w) {
  if (want === "any") return null;
  const k = wxClass(w);
  if (k[want]) return null;
  const got = ["snow", "rain", "lowvis"].find(c => c !== want && k[c]);
  return (got ? RAND_WORD[got] : want === "lowvis" ? "good visibility" : "no precipitation") + " instead of " + RAND_WORD[want];
}

function randLightMiss(want, light) {
  if (want === "any" || want === light) return null;
  if (light === "twilight") return want === "night" ? "twilight, not dark yet" : "twilight, not full daylight";
  return light + " instead of " + want;
}

function randPt(a) { const la = a.lat * Math.PI / 180; return { a, la, lo: a.lon * Math.PI / 180, cl: Math.cos(la), ob: null }; }
function randDist(p, q) {
  const s1 = Math.sin((q.la - p.la) / 2), s2 = Math.sin((q.lo - p.lo) / 2);
  return 2 * RAND_NM * Math.asin(Math.sqrt(Math.min(1, s1 * s1 + p.cl * q.cl * s2 * s2)));
}

// 1-degree lat/lon buckets, so a search near a point skips the rest of the world
const randKey = (r, c) => (r + 90) * 360 + (((c + 180) % 360) + 360) % 360;
function randGrid(pts) {
  const g = new Map();
  for (const p of pts) {
    const k = randKey(Math.min(89, Math.floor(p.a.lat)), Math.floor(p.a.lon)), c = g.get(k);
    if (c) c.push(p); else g.set(k, [p]);
  }
  return g;
}
// calls fn for every point that may lie within nm of p (a superset), returns the work done; with `all` (the
// grid's points) given, a search wider than the list walks the list instead of the cells
function randNear(g, all, p, nm, fn) {
  const lat = p.a.lat, lon = p.a.lon, dLat = nm / 60;
  const r0 = Math.max(-90, Math.floor(lat - dLat)), r1 = Math.min(89, Math.floor(lat + dLat));
  const edge = Math.max(Math.abs(lat - dLat), Math.abs(lat + dLat));
  const dLon = edge >= 89 ? 180 : nm / (60 * Math.cos(edge * Math.PI / 180));
  const c0 = dLon >= 180 ? -180 : Math.floor(lon - dLon), c1 = dLon >= 180 ? 179 : Math.floor(lon + dLon);
  if (all && (dLon >= 180 || (r1 - r0 + 1) * (c1 - c0 + 1) >= all.length)) { for (const q of all) fn(q); return all.length; }
  let n = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cell = g.get(randKey(r, c)); n++;
    if (cell) { n += cell.length; for (const q of cell) fn(q); }
  }
  return n;
}

function randShuffle(a, rand) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

function generate(input) {
  const { airports, rwy, obs, tafs, lim, prompts: p, now, rand } = input;
  const etd = Math.ceil(now / 600000) * 600000, kt = lim.kt;

  // airports the aircraft can use (index: [longest land runway, longest paved, lit]): a paved runway >= the need,
  // +10 % per 1,000 ft elevation; for propeller GA also an unpaved one with 25 % more (jets and airliners: paved only)
  // Only airports FS2024 is likely to have: a 4-letter ICAO ident, and no air base / AFB unless it has a METAR station
  const reporting = new Set(obs.map(o => o.id)), pts = [], byId = new Map();
  for (const a of airports) {
    if (!RAND_ICAO.test(a.icao) || (RAND_MIL.test(a.name || "") && !reporting.has(a.icao))) continue;
    const r = rwy[a.icao], need = lim.minRwyFt * (1 + 0.10 * Math.max(a.alt || 0, 0) / 1000);
    if (!r || (r[1] < need && (lim.paved || r[0] < need * 1.25))) continue;
    const q = randPt(a); q.lit = !!r[2]; pts.push(q); byId.set(a.icao, q);
  }
  for (const o of obs) { // the newest current observation of each usable airport
    const q = byId.get(o.id);
    if (q && now - o.t <= RAND_FRESH && (!q.ob || o.t > q.ob.t)) q.ob = o;
  }

  // departures: a current report is required unless both departure weather and time are "any"
  const free = p.dep === "any" && p.time === "any", deps = [];
  for (const q of pts) {
    if (!free && !q.ob) continue;
    const light = dayNight(sunElevation(q.a.lat, q.a.lon, etd));
    if (light !== "day" && !q.lit) continue; // twilight or night: a lit runway
    const lm = randLightMiss(p.time, light);
    // far: the departure is the opposite of the wanted time (day for night), not just twilight
    deps.push({ q, light, far: lm && light !== "twilight" ? 1 : 0, m: [lm, q.ob && randWxMiss(p.dep, q.ob)].filter(Boolean) });
  }
  randShuffle(deps, rand).sort((a, b) => a.m.length - b.m.length || a.far - b.far); // fewest misses first, twilight before the opposite, random within

  // distance band on the estimated minutes; undefined = out of the band even as a near miss
  const distMiss = min => min < 20 ? undefined
    : p.dist === "short" ? (min <= 120 ? null : min <= 150 ? randHm(min) + " — just over short" : undefined)
    : p.dist === "long" ? (min > 120 ? null : min >= 90 ? randHm(min) + " — under long" : undefined)
    : null;
  const maxNm = Math.min(lim.rangeNM, p.dist === "short" ? (151 - 15) / 60 * kt : Infinity);

  // arrival weather: the current METAR up to 90 minutes out, beyond that the TAF at the estimated arrival time
  const arrPts = p.arr === "any" ? pts : pts.filter(q => q.ob || tafs[q.a.icao]);
  const grid = randGrid(arrPts);
  const arrWx = (q, min) => {
    if (min <= 90) { const o = q.ob; return o ? { src: "metar", raw: o.raw, cat: o.cat, wx: o.wx, vis: o.vis, ceil: o.ceil } : null; }
    const taf = tafs[q.a.icao], w = taf ? tafAt(taf, etd + min * 60000) : null;
    return w ? { src: "taf", raw: taf.raw, cat: w.cat, wx: w.wx, vis: w.vis, ceil: w.ceil } : null;
  };

  let work = 0;
  // the best arrival for one departure: fewest arrival-side misses, random among equals
  const option = d => {
    const cand = [];
    work += randNear(grid, arrPts, d.q, maxNm, q => {
      if (q === d.q || q.a.icao === d.q.a.icao) return;
      const nm = randDist(d.q, q);
      if (nm <= 5 || nm > maxNm) return; // never the same field under another ident
      const min = Math.round(estMinutes(nm, kt)), dm = distMiss(min);
      if (dm !== undefined) cand.push({ q, nm, min, dm });
    });
    let best = null, bestN = 3;
    for (let n = cand.length; n > 0 && bestN > 0; n--) { // lazy shuffle: stop at the first arrival with no miss
      const j = Math.floor(rand() * n), c = cand[j]; cand[j] = cand[n - 1];
      const dn = c.dm ? 1 : 0;
      if (dn >= bestN) continue;
      if (!c.q.lit && sunElevation(c.q.a.lat, c.q.a.lon, etd + c.min * 60000) <= 0) continue; // dark on arrival: lit only
      const w = arrWx(c.q, c.min), am = p.arr === "any" ? null : w ? randWxMiss(p.arr, w) : "no report at arrival";
      work += 20;
      if (dn + (am ? 1 : 0) < bestN) { bestN = dn + (am ? 1 : 0); best = { c, w, am }; }
    }
    if (!best) return null;
    const { c, w, am } = best;
    return { dep: d.q.a, arr: c.q.a, nm: Math.round(c.nm), min: c.min, light: d.light, depWx: d.q.ob, arrWx: w,
      misses: [...d.m, c.dm, am].filter(Boolean), far: d.far, _q: d.q };
  };

  // one option per departure; departures 100 NM apart first, the rest only if those run out. A departure's own
  // misses bound its option from below, so the search stops once 5 options can no longer be beaten.
  const pool = [], perLevel = [0, 0, 0, 0, 0], spaced = new Map(), deferred = [];
  const settled = bound => { let n = 0; for (let k = 0; k <= bound; k++) n += perLevel[k]; return n >= RAND_COUNT; };
  const nearSpaced = q => { let hit = false; randNear(spaced, null, q, RAND_SPACING, s => { if (!hit && randDist(q, s) < RAND_SPACING) hit = true; }); return hit; };
  const scan = (list, spacing) => {
    for (const d of list) {
      if (settled(d.m.length) || (pool.length >= RAND_COUNT && work > RAND_WORK)) return;
      if (spacing && nearSpaced(d.q)) { deferred.push(d); continue; }
      const o = option(d);
      if (!o) continue;
      pool.push(o); perLevel[o.misses.length]++;
      if (spacing) { const k = randKey(Math.min(89, Math.floor(d.q.a.lat)), Math.floor(d.q.a.lon)), c = spaced.get(k); if (c) c.push(d.q); else spaced.set(k, [d.q]); }
    }
  };
  scan(deps, true);
  scan(deferred, false);

  // pick fewest misses first; within each level prefer departures 100 NM from those already picked
  pool.sort((a, b) => a.misses.length - b.misses.length || a.far - b.far);
  const out = [], used = new Set();
  for (let lv = 0; lv < perLevel.length && out.length < RAND_COUNT; lv++) {
    const level = pool.filter(o => o.misses.length === lv);
    for (const strict of [true, false]) for (const o of level) {
      if (out.length >= RAND_COUNT || used.has(o)) continue;
      if (strict && out.some(x => randDist(x._q, o._q) < RAND_SPACING)) continue;
      out.push(o); used.add(o);
    }
  }
  return out.map(({ _q, far, ...o }) => o);
}

/* =====================================================================
   The panel (browser only): on the start screen in place of the setup form. Opening it loads the worldwide
   weather files and the runway index (never at app start); Generate screens them for the chosen aircraft and
   prompts; picking an option plans it like an example flight (Chips.planFlight).
   ===================================================================== */
Object.assign(RandomFlight, (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CHOICES = { group: ["ga", "airliner"], time: ["day", "night", "any"], dep: ["snow", "rain", "lowvis", "any"],
    arr: ["snow", "rain", "lowvis", "any"], dist: ["short", "long", "any"] };
  const DEF_AC = { ga: "apm:C172", airliner: "oap:a320" };
  const ANY = { time: "any", dep: "any", arr: "any", dist: "any" };
  const LOADING = "Loading live weather from aviationweather.gov…";
  let ans = null, data = null, seq = 0, busy = false, shown = [], retry = null;

  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  function answers() {
    let s = null; try { s = JSON.parse(lsGet("xperf.random") || "null"); } catch (_) {}
    const a = { group: String(lsGet("xperf.ac") || "").startsWith("oap:") ? "airliner" : "ga", ...ANY };
    for (const k in CHOICES) if (s && CHOICES[k].includes(s[k])) a[k] = s[k];
    return a;
  }
  function save() { try { localStorage.setItem("xperf.random", JSON.stringify(ans)); } catch (_) {} }

  // the aircraft of the chosen group, copied from the form's list; default: the remembered aircraft, else C172 / A320
  function fillAircraft() {
    const sel = $("rfAc"), pre = ans.group === "airliner" ? "oap:" : "apm:";
    sel.innerHTML = "";
    for (const g of $("ac").querySelectorAll("optgroup")) {
      const opts = [...g.children].filter(o => o.value.startsWith(pre));
      if (!opts.length) continue;
      const c = document.createElement("optgroup"); c.label = g.label;
      for (const o of opts) c.appendChild(o.cloneNode(true));
      sel.appendChild(c);
    }
    const last = lsGet("xperf.ac");
    sel.value = last && last.startsWith(pre) && [...sel.options].some(o => o.value === last) ? last : DEF_AC[ans.group];
  }
  function syncSegs() {
    document.querySelectorAll("#rfPanel [data-rf]").forEach(seg => seg.querySelectorAll("[data-rv]").forEach(b =>
      b.setAttribute("aria-pressed", String(ans[seg.dataset.rf] === b.dataset.rv))));
  }
  function setBusy(on) { busy = on; $("rfGo").disabled = on; $("rfAny").disabled = on; }
  // an error's Retry runs `again` (re-run Generate); without one it only reloads the weather
  function state(kind, text, again) {
    retry = kind === "error" && again || null;
    const el = $("rfState");
    el.className = "rfstate" + (kind ? " " + kind : "");
    el.innerHTML = kind === "loading" ? `<span class="rfspin" aria-hidden="true"></span>${esc(text)}`
      : kind === "error" ? `<span class="err">${esc(text)}</span><button type="button" class="sm rfretry" id="rfRetry">Retry</button>`
      : esc(text || "");
  }

  // the two worldwide files (XD keeps them 5 minutes) and the runway index; parsed again only when the text changed
  function load() {
    const my = ++seq;
    $("rfRes").innerHTML = ""; shown = [];
    state("loading", LOADING);
    return Promise.all([XD.wxBulk("metars"), XD.wxBulk("tafs"), XD.runwayIndex()]).then(([mt, tt, rwy]) => {
      const obs = data && data.mt === mt ? data.obs : parseMetarCsv(mt);
      if (!obs.length) {         // an empty file is missing weather, not "no matches" (TAFs may legitimately be few)
        XD.wxBulkEvict("metars"); // else Retry would get the same empty file from XD's 5-minute cache
        const e = new Error("Live weather reports came back empty from aviationweather.gov — try again in a minute.");
        if (my === seq) state("error", e.message);
        throw e;
      }
      const tafs = data && data.tt === tt ? data.tafs : parseTafXml(tt);
      data = { mt, tt, rwy, obs, tafs };
      if (my === seq) state("", `Live weather: ${obs.length.toLocaleString()} reports and ${Object.keys(tafs).length.toLocaleString()} forecasts worldwide.`);
      return data;
    }, e => { if (my === seq) state("error", e.message); throw e; });
  }

  async function run(full) {
    if (busy) return;
    if (!$("rfAc").value) fillAircraft();                 // opened while the aircraft list was still loading
    const acId = $("rfAc").value, prompts = full ? ANY : { time: ans.time, dep: ans.dep, arr: ans.arr, dist: ans.dist };
    const again = () => run(full);
    if (!acId || !DB.airports.length) { state("error", "The app's data is still loading — try again in a moment.", again); return; }
    setBusy(true);
    Busy.show("loading live weather…", [acId.split(":")[1].toUpperCase(),
      ...["dep", "time", "dist"].map(k => prompts[k]).filter(v => v !== "any").map(v => v === "lowvis" ? "low visibility" : v)].join(" · "));
    try {
      let d;
      try { d = await load(); } catch (_) { return; }        // load() shows the reason and Retry
      Busy.text(`searching ${d.obs.length.toLocaleString()} weather reports…`);
      if ($("rfPanel").hidden) return;                       // a flight was planned another way meanwhile: keep its aircraft
      if ($("ac").value !== acId) AcPicker.set(acId);
      await MODEL_P;
      if (!MODEL || MODEL.id !== acId) { state("error", "Could not load the aircraft's performance data.", again); return; }
      const opts = generate({ airports: DB.airports, rwy: d.rwy, obs: d.obs, tafs: d.tafs, lim: aircraftLimits(MODEL), prompts,
        now: RandomFlight.now(), rand: () => RandomFlight.rand() });
      shown = opts.map(o => ({ ...o, acId }));
      $("rfRes").innerHTML = shown.map(card).join("");
      state("", !opts.length ? "Nothing close enough right now — try Any for one of the prompts."
        : opts.some(o => o.misses.length) ? "Not everything matches right now — the closest flights say what differs." : "");
    } catch (e) { state("error", e.message, again); console.error(e); }
    finally { setBusy(false); Busy.hide(); }
  }

  /* ---------- option cards */
  const FR = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"];
  function visTxt(v) {                  // eighths below 1 SM, quarters to 3 SM (metric reports convert to odd decimals)
    if (v >= 3) return String(Math.round(v));
    const e = v < 1 ? Math.max(1, Math.round(v * 8)) : Math.round(v * 4) * 2;
    return (Math.floor(e / 8) || "") + FR[e % 8];
  }
  // "FG ¼ SM OVC002": present weather, visibility below 6 SM, the ceiling layer as the METAR prints it
  function shortWx(w) {
    const out = [];
    if (w.wx) out.push(w.wx);
    if (w.vis != null && w.vis < 6) out.push(visTxt(w.vis) + " SM");
    if (w.ceil != null) {
      const h = String(Math.round(w.ceil / 100)).padStart(3, "0");
      const m = w.src !== "taf" && new RegExp("\\b(BKN|OVC|VV)" + h + "\\b").exec(w.raw || "");
      out.push(m ? m[0] : "CIG " + h);
    }
    return out.join(" ");
  }
  function tag(side, w) {
    if (!w) return `<span class="rftag none">${side} · no report</span>`;
    const cat = ["VFR", "MVFR", "IFR", "LIFR"].includes(w.cat) ? w.cat : "", s = shortWx(w);
    return `<span class="rftag ${cat ? cat.toLowerCase() : "none"}" title="${esc(w.raw)}">${side} ${cat || "—"}${s ? " · " + esc(s) : ""}</span>`;
  }
  function card(o, i) {
    const raw = `${o.dep.icao}: ${o.depWx ? o.depWx.raw : "no report"}\n${o.arr.icao}: ${o.arrWx ? o.arrWx.raw : "no report"}`;
    return `<button type="button" class="rfopt" data-i="${i}" data-dep="${esc(o.dep.icao)}" data-arr="${esc(o.arr.icao)}" title="${esc(raw)}">` +
      `<span class="rfrt"><b>${esc(o.dep.icao)} → ${esc(o.arr.icao)}</b><span class="rfmeta">${o.nm} NM · ${randHm(o.min)} · ${o.light}</span></span>` +
      `<span class="rfnames">${esc(o.dep.name)} → ${esc(o.arr.name)}</span>` +
      `<span class="rfwx">${tag("DEP", o.depWx)}${tag("ARR", o.arrWx)}${o.arrWx && o.arrWx.src === "taf" ? `<span class="rffc">forecast</span>` : ""}</span>` +
      (o.misses.length ? `<span class="rfmiss">${esc(o.misses.join(" · "))}</span>` : "") + `</button>`;
  }
  function pick(o) {
    close();
    const nav = $("nav").value, etd = new Date(Math.ceil(RandomFlight.now() / 600000) * 600000).toISOString().slice(0, 16);
    // a pasted route belongs to another airport pair: fly the new one direct
    Chips.planFlight(o.acId, o.dep.icao, o.arr.icao, nav && nav !== "import" ? nav : "direct", etd);
  }

  /* ---------- open / close */
  function open() {
    if (!document.querySelector("#ac optgroup")) return;     // app data still loading: like the example flights, nothing yet
    if (document.body.classList.contains("planned")) Chips.newFlight();
    else if (Shell.current() === "settings") Shell.showView("overview");   // the start screen is hidden there
    if (!ans) ans = answers();
    fillAircraft(); syncSegs();
    $("rfPanel").hidden = false; document.body.classList.add("random-open");
    Shell.setCrumb("Random flight");
    load().catch(() => {});
    const first = $("rfPanel").querySelector('[aria-pressed="true"]');
    if (first) first.focus({ preventScroll: true });
  }
  // also called when any plan starts (calculate) and by New flight, so the panel never outlives the start screen
  function close() {
    if ($("rfPanel").hidden) return;
    $("rfPanel").hidden = true; document.body.classList.remove("random-open");
    Shell.setCrumb("New flight");
  }

  if (typeof document !== "undefined") document.addEventListener("click", e => {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest("[data-random]")) { open(); return; }
    if (!t.closest("#rfPanel")) return;
    const b = t.closest("[data-rf] [data-rv]");
    if (b) { const k = b.closest("[data-rf]").dataset.rf; ans[k] = b.dataset.rv; if (k === "group") fillAircraft(); syncSegs(); save(); return; }
    if (t.closest("#rfGo")) { run(false); return; }
    if (t.closest("#rfAny")) { run(true); return; }
    if (t.closest("#rfRetry")) { if (retry) retry(); else load().catch(() => {}); return; }
    if (t.closest("#rfBack")) { close(); $("dep").focus(); return; }
    const c = t.closest(".rfopt"); if (c && shown[+c.dataset.i]) pick(shown[+c.dataset.i]);
  });
  if (typeof document !== "undefined") document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || $("rfPanel").hidden || Palette.isOpen()) return;
    e.preventDefault(); close(); $("dep").focus();
  });
  return { open, close };
})());
