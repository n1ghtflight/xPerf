"""Navigation & airport data for the Flight Performance Calculator.

Sources (all free; cached under ./cache):
  * OurAirports (public domain)  - navaids (VOR/NDB/DME), runways, frequencies
  * FAA NASR, current AIRAC cycle - US ILS/LOC/GS/DME (official, current)
  * X-Plane nav.dat via OpenAP (GPL, 2013 cycle) - ILS outside the US (flagged as old)
  * FAA d-TPP, current cycle     - US approach plates / airport diagrams (official PDFs)
  * aviationweather.gov           - live METAR / TAF, station list for nearest-station fallback
"""
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
UA = "Mozilla/5.0 (flight-performance-calculator; personal use)"
OA = "https://davidmegginson.github.io/ourairports-data/"
XPLANE_NAV = "https://raw.githubusercontent.com/TUDelft-CNS-ATM/openap/master/openap/data/nav/nav.dat"
AWC = "https://aviationweather.gov"
DAY = 86400
AIRPORT_TYPES = {"large_airport", "medium_airport", "small_airport", "seaplane_base"}    # the airport list (server.py)

_lock = threading.RLock()     # re-entrant: builders may use other memoized datasets
_mem = {}


# ---------------------------------------------------------------- helpers
def fetch(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cached_file(name, url, ttl, valid=None):
    """Download url into cache/name unless a fresh copy exists. Falls back to a stale copy if offline.
    valid(bytes) -> bool, when given, must accept a cached copy to serve it and a download to keep it: a download it
    rejects counts as a failed one (the last good copy is served, else the call raises) and is never cached."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, name)
    old = None
    if os.path.exists(path):
        with open(path, "rb") as f:
            old = f.read()
        if valid and not valid(old):
            old = None                                    # a bad copy cached earlier is no fallback either
        elif time.time() - os.path.getmtime(path) < ttl:
            return old
    try:
        data = fetch(url)
        if valid and not valid(data):
            raise ValueError(f"{name}: the download is empty or not the expected format")
    except Exception:
        if old is not None:
            return old
        raise
    # write a temp file beside it, then swap it in: a concurrent reader (another thread or server) never sees half a file
    fd, tmp = tempfile.mkstemp(prefix=name + ".", suffix=".tmp", dir=CACHE_DIR)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        os.replace(tmp, path)
    except OSError:          # Windows: the old copy is open in another reader; it is refreshed next time
        os.remove(tmp)
    return data


def memo(key, builder):
    with _lock:
        if key not in _mem:
            _mem[key] = builder()
        return _mem[key]


def num(v, cast=float):
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None


def nm_between(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl, dn = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dl / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dn / 2) ** 2
    return 2 * 3440.065 * math.asin(min(1, math.sqrt(a)))


# ---------------------------------------------------------------- AIRAC cycle
AIRAC_REF = dt.date(2026, 10, 1)        # FAA cycle 2610 effective date


def airac(today=None):
    """Current AIRAC cycle -> (effective date, 'YYNN')."""
    today = today or dt.datetime.utcnow().date()
    k = (today - AIRAC_REF).days // 28
    eff = AIRAC_REF + dt.timedelta(days=28 * k)
    first = eff
    while (first - dt.timedelta(days=28)).year == eff.year:
        first -= dt.timedelta(days=28)
    return eff, f"{eff.year % 100:02d}{(eff - first).days // 28 + 1:02d}"


# ---------------------------------------------------------------- navaids
NAVAID_TYPES = {"VOR", "VOR-DME", "VORTAC", "NDB", "NDB-DME", "DME", "TACAN"}


def navaids_json():
    """[ident, name, type, freq_khz, lat, lon, elev_ft, country, slaved_var, mag_var, usage, power, dme_channel, airport]"""
    def build():
        text = cached_file("navaids.csv", OA + "navaids.csv", 7 * DAY).decode("utf-8", "ignore")
        rows = []
        for n in csv.DictReader(io.StringIO(text)):
            if n["type"] not in NAVAID_TYPES:
                continue
            lat, lon = num(n["latitude_deg"]), num(n["longitude_deg"])
            if lat is None or lon is None:
                continue
            rows.append([n["ident"], n["name"], n["type"], num(n["frequency_khz"]), round(lat, 5), round(lon, 5),
                         num(n["elevation_ft"], int), n["iso_country"], num(n["slaved_variation_deg"]),
                         num(n["magnetic_variation_deg"]), n["usageType"], n["power"], n["dme_channel"], n["associated_airport"]])
        return json.dumps(rows, separators=(",", ":")).encode()
    return memo("navaids", build)


# ---------------------------------------------------------------- runways / frequencies
def _index_csv(name, key):
    text = cached_file(name, OA + name, 7 * DAY).decode("utf-8", "ignore")
    idx = {}
    for r in csv.DictReader(io.StringIO(text)):
        idx.setdefault(r[key].upper(), []).append(r)
    return idx


def runways(cands):
    idx = memo("runways", lambda: _index_csv("runways.csv", "airport_ident"))
    for c in cands:
        if c in idx:
            out = []
            for r in idx[c]:
                if r["closed"] == "1":
                    continue
                def end(p):
                    return {"id": r[p + "_ident"], "lat": num(r[p + "_latitude_deg"]), "lon": num(r[p + "_longitude_deg"]),
                            "elev": num(r[p + "_elevation_ft"]), "hdgT": num(r[p + "_heading_degT"]),
                            "dthr": num(r[p + "_displaced_threshold_ft"]) or 0}
                out.append({"length": num(r["length_ft"]), "width": num(r["width_ft"]), "surface": r["surface"],
                            "lighted": r["lighted"] == "1", "ends": [end("le"), end("he")]})
            return out
    return []


_PAVED = re.compile(r"ASP|CON|PEM|BIT|TAR|PAV|ASF|CONC|BRI|MAC", re.I)    # same pattern as SURF_PAVED in nav.js
_NOT_LAND = re.compile(r"WAT|SNOW|\bICE\b", re.I)                         # water lanes, snow and ice strips


def runway_index():
    """airport-list ident -> [longestLandFt, longestPavedFt, lit] over open land runways (no water lanes, snow or
    ice; lit = 1 if any of them is lighted). Keyed like server.get_airports: icao_code, else gps_code, else ident;
    airports with no open land runway, or whose key is not 4 letters (A-Z), are left out."""
    def build():
        idx = memo("runways", lambda: _index_csv("runways.csv", "airport_ident"))
        text = cached_file("airports.csv", OA + "airports.csv", 7 * DAY).decode("utf-8", "ignore")
        out = {}
        for a in csv.DictReader(io.StringIO(text)):
            if a["type"] not in AIRPORT_TYPES or a["ident"].upper() not in idx:
                continue
            longest = paved = lit = 0
            seen = False
            for r in idx[a["ident"].upper()]:
                if r["closed"] == "1" or _NOT_LAND.search(r["surface"] or ""):
                    continue
                seen = True
                n = int(num(r["length_ft"]) or 0)
                longest = max(longest, n)
                if _PAVED.search(r["surface"] or ""):
                    paved = max(paved, n)
                if r["lighted"] == "1":
                    lit = 1
            key = a.get("icao_code") or a.get("gps_code") or a["ident"]
            if seen and re.fullmatch(r"[A-Z]{4}", key):     # 4-letter ICAO-style idents only: other fields are unlikely to be in the sim
                out.setdefault(key, [longest, paved, lit])
        return out
    return memo("rwyindex", build)


def wx_bulk(kind):
    """Raw .gz bytes of aviationweather.gov's worldwide METAR (csv) or TAF (xml) cache file, cached 300 s.
    An empty or non-gzip answer (the site sometimes sends a 0-byte 200) is a failed download, never cached or returned."""
    name = {"metars": "metars.cache.csv.gz", "tafs": "tafs.cache.xml.gz"}[kind]
    return cached_file(name, f"{AWC}/data/cache/{name}", 300, valid=lambda d: d[:2] == b"\x1f\x8b" and len(d) > 2)


def frequencies(cands):
    idx = memo("freqs", lambda: _index_csv("airport-frequencies.csv", "airport_ident"))
    for c in cands:
        if c in idx:
            return [{"type": r["type"], "desc": r["description"], "mhz": num(r["frequency_mhz"])} for r in idx[c]]
    return []


# ---------------------------------------------------------------- ILS
def _nasr_ils():
    eff, _ = airac()
    stamp = eff.strftime("%d_%b_%Y")
    url = f"https://nfdc.faa.gov/webContent/28DaySub/extra/{stamp}_ILS_CSV.zip"
    z = zipfile.ZipFile(io.BytesIO(cached_file(f"nasr_ils_{stamp}.zip", url, 60 * DAY)))
    rd = lambda n: list(csv.DictReader(io.StringIO(z.read(n).decode("latin1"))))
    gs = {(r["ARPT_ID"], r["RWY_END_ID"], r["ILS_LOC_ID"]): r for r in rd("ILS_GS.csv")}
    dme = {(r["ARPT_ID"], r["RWY_END_ID"], r["ILS_LOC_ID"]): r for r in rd("ILS_DME.csv")}
    kinds = {"LS": "ILS", "LD": "ILS/DME", "LC": "LOC", "LE": "LOC/DME", "LG": "LOC/GS", "SD": "SDF/DME", "SF": "SDF",
             "LA": "LDA", "LO": "LDA/DME", "DD": "LDA/DME", "ML": "MLS"}
    idx = {}
    for r in rd("ILS_BASE.csv"):
        k = (r["ARPT_ID"], r["RWY_END_ID"], r["ILS_LOC_ID"])
        g, d = gs.get(k), dme.get(k)
        magvar = (num(r["MAG_VAR"]) or 0) * (-1 if r["MAG_VAR_HEMIS"] == "W" else 1)
        idx.setdefault(r["ARPT_ID"], []).append({
            "rwy": r["RWY_END_ID"], "ident": "I-" + r["ILS_LOC_ID"], "type": kinds.get(r["SYSTEM_TYPE_CODE"], r["SYSTEM_TYPE_CODE"]),
            "freq": num(r["LOC_FREQ"]), "courseM": num(r["APCH_BEAR"]), "magvar": magvar, "cat": r["CATEGORY"] or None,
            "gs": num(g["G_S_ANGLE"]) if g else None, "gsElev": num(g["SITE_ELEVATION"]) if g else None,
            "dme": d["CHANNEL"] if d else None, "status": r["COMPONENT_STATUS"],
            "lat": num(r["LAT_DECIMAL"]), "lon": num(r["LONG_DECIMAL"])})
    return {"cycle": eff.isoformat(), "idx": idx}


def _xplane_ils():
    text = cached_file("xplane_nav.dat", XPLANE_NAV, 180 * DAY).decode("latin1")
    loc, gs, dme = {}, {}, {}
    for line in text.splitlines():
        p = line.split()
        if len(p) < 11 or p[0] not in ("4", "5", "6", "12"):
            continue
        apt, rwy, ident = p[8], p[9], p[7]
        key = (apt, rwy, ident)
        if p[0] in ("4", "5"):
            loc[key] = {"rwy": rwy, "ident": ident, "type": " ".join(p[10:]).replace("ILS-cat-", "ILS CAT "),
                        "freq": int(p[4]) / 100, "courseT": float(p[6]), "lat": float(p[1]), "lon": float(p[2]),
                        "elev": int(p[3])}
        elif p[0] == "6":
            v = float(p[6])
            gs[key] = {"angle": int(v // 1000) / 100, "elev": int(p[3])}
        elif p[0] == "12":
            dme[key] = True
    idx = {}
    for k, l in loc.items():
        g = gs.get(k)
        l["gs"] = g["angle"] if g else None
        l["dme"] = "ILS-DME" if k in dme else None
        idx.setdefault(k[0], []).append(l)
    return idx


def ils(cands, country):
    if country == "US":
        try:
            nasr = memo("nasr_ils", _nasr_ils)
            for c in cands:
                key = c[1:] if len(c) == 4 and c[0] in "KP" else c
                for k in (key, c):
                    if k in nasr["idx"]:
                        return {"source": f"FAA NASR, cycle effective {nasr['cycle']}", "current": True, "list": nasr["idx"][k]}
            return {"source": f"FAA NASR, cycle effective {nasr['cycle']}", "current": True, "list": []}
        except Exception as e:
            print("NASR ILS unavailable:", e)
    xp = memo("xplane_ils", _xplane_ils)
    for c in cands:
        if c in xp:
            return {"source": "X-Plane nav.dat (GPL), AIRAC 2013.10 — frequencies/courses may have changed", "current": False, "list": xp[c]}
    return {"source": "no ILS on record", "current": False, "list": []}


# ---------------------------------------------------------------- FAA airways (Victor / Jet / colored LF airways)
def _nasr_zip(kind):
    eff, _ = airac()
    stamp = eff.strftime("%d_%b_%Y")
    url = f"https://nfdc.faa.gov/webContent/28DaySub/extra/{stamp}_{kind}_CSV.zip"
    return zipfile.ZipFile(io.BytesIO(cached_file(f"nasr_{kind.lower()}_{stamp}.zip", url, 60 * DAY))), eff


NAV_FAMILY = {"VORTAC": "VOR", "VOR/DME": "VOR", "VOR": "VOR", "TACAN": "VOR", "DME": "VOR",
              "NDB": "NDB", "NDB/DME": "NDB"}


def _fixnav():
    def build():
        zf, eff = _nasr_zip("FIX")
        fixes = {}
        for r in csv.DictReader(io.StringIO(zf.read("FIX_BASE.csv").decode("latin1"))):
            lat, lon = num(r["LAT_DECIMAL"]), num(r["LONG_DECIMAL"])
            if lat is not None:
                fixes.setdefault(r["FIX_ID"], []).append((lat, lon, r["STATE_CODE"], r["ICAO_REGION_CODE"]))
        zn, _ = _nasr_zip("NAV")
        navs = {}
        for r in csv.DictReader(io.StringIO(zn.read("NAV_BASE.csv").decode("latin1"))):
            lat, lon = num(r["LAT_DECIMAL"]), num(r["LONG_DECIMAL"])
            if r["NAV_TYPE"] in ("VOT", "FAN MARKER"):      # VOR test facilities share the real VOR's ident
                continue
            fam = "NDB" if "NDB" in r["NAV_TYPE"] else "VOR"
            if lat is not None:
                navs.setdefault(r["NAV_ID"], []).append((lat, lon, r["STATE_CODE"], fam, r["NAV_TYPE"]))
        return fixes, navs, eff
    return memo("fixnav", build)


def airways_json():
    """{cycle, points: [[id, lat, lon, kind, navType]], segs: [[awy, a, b, mea, moca, maa, crs, oppCrs, copNav, copDist]]}
    Victor (V), Jet (J) and Alaska colored LF/MF airways (A/B/G/R). RNAV T/Q/Y routes are left out (they need GPS)."""
    def build():
        fixes, navs, eff = _fixnav()
        za, _ = _nasr_zip("AWY")
        rows = list(csv.DictReader(io.StringIO(za.read("AWY_SEG_ALT.csv").decode("latin1"))))
        groups = {}
        for r in rows:
            aid, loc = r["AWY_ID"], r["AWY_LOCATION"]
            if not (aid[:1] in "VJ" or (loc == "A" and aid[:1] in "ABGR")):
                continue
            groups.setdefault((loc, aid), []).append(r)
        points, pidx, segs = [], {}, []

        def resolve(r, prev):
            pid, ptype = r["FROM_POINT"], r["FROM_PT_TYPE"].strip()
            fam = NAV_FAMILY.get(ptype)
            if fam:
                cands = [(c[0], c[1], c[2], "nav", c[4]) for c in navs.get(pid, []) if c[3] == fam] or                         [(c[0], c[1], c[2], "nav", c[4]) for c in navs.get(pid, [])]
            else:
                cands = [(c[0], c[1], c[2], "fix", "") for c in fixes.get(pid, [])]
            if not cands:
                return None
            if prev is not None:
                c = min(cands, key=lambda c: nm_between(prev[1], prev[2], c[0], c[1]))
            else:
                same = [c for c in cands if c[2] == r["STATE_CODE"]]
                c = (same or cands)[0]
            key = (pid, round(c[0], 4), round(c[1], 4))
            if key not in pidx:
                pidx[key] = len(points)
                points.append([pid, round(c[0], 5), round(c[1], 5), c[3], c[4]])
            return pidx[key]

        for (loc, aid), rs in groups.items():
            rs.sort(key=lambda r: num(r["POINT_SEQ"], int) or 0)
            prev = None
            ids = []
            for r in rs:
                i = resolve(r, points[prev] if prev is not None else None)
                ids.append(i)
                prev = i if i is not None else prev
            for k in range(len(rs) - 1):
                r, a, b = rs[k], ids[k], ids[k + 1]
                if a is None or b is None or a == b or r["AWY_SEG_GAP_FLAG"] == "Y":
                    continue
                mea = max([v for v in (num(r["MIN_ENROUTE_ALT"], int), num(r["MIN_ENROUTE_ALT_OPPOSITE"], int)) if v] or [0])
                segs.append([aid, a, b, mea or None, num(r["MIN_OBSTN_CLNC_ALT"], int), num(r["MAX_AUTH_ALT"], int),
                             num(r["MAG_COURSE"]), num(r["OPP_MAG_COURSE"]), r["CHGOVR_PT"] or None, num(r["CHGOVR_PT_DIST"])])
        return json.dumps({"cycle": eff.isoformat(), "points": points, "segs": segs}, separators=(",", ":")).encode()
    return memo("airways", build)


# ---------------------------------------------------------------- FAA d-TPP charts
def _dtpp():
    eff, cyc = airac()
    url = f"https://aeronav.faa.gov/d-tpp/{cyc}/xml_data/d-tpp_Metafile.xml"
    raw = cached_file(f"dtpp_{cyc}.xml", url, 40 * DAY).decode("utf-8", "ignore")
    idx = {}
    for m in re.finditer(r'<airport_name ID="[^"]*" military="[^"]*" apt_ident="([^"]*)" icao_ident="([^"]*)"[^>]*>(.*?)</airport_name>', raw, re.S):
        faa, icao, body = m.groups()
        charts = []
        for rec in re.finditer(r"<chart_code>([^<]*)</chart_code>\s*<chart_name>([^<]*)</chart_name>.*?<pdf_name>([^<]*)</pdf_name>", body, re.S):
            code, name, pdf = rec.groups()
            charts.append({"code": code, "name": name, "url": f"https://aeronav.faa.gov/d-tpp/{cyc}/{pdf}"})
        for k in {faa, icao} - {""}:
            idx[k] = charts
    return {"cycle": cyc, "eff": eff.isoformat(), "idx": idx}


def charts(cands, country):
    if country != "US":
        return None
    try:
        d = memo("dtpp", _dtpp)
    except Exception as e:
        print("d-TPP unavailable:", e)
        return None
    for c in cands:
        for k in (c, c[1:] if len(c) == 4 and c[0] == "K" else c):
            if k in d["idx"]:
                return {"cycle": d["cycle"], "eff": d["eff"], "list": d["idx"][k]}
    return {"cycle": d["cycle"], "eff": d["eff"], "list": []}


# ---------------------------------------------------------------- weather
_wx_cache = {}


def _awc(path):
    hit = _wx_cache.get(path)
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    raw = fetch(AWC + path, timeout=20)
    data = json.loads(raw) if raw.strip() else []
    _wx_cache[path] = (time.time(), data)
    return data


def _stations():
    raw = cached_file("awc_stations.json.gz", AWC + "/data/cache/stations.cache.json.gz", DAY)
    return [s for s in json.loads(gzip.decompress(raw)) if s.get("icaoId") and "METAR" in (s.get("siteType") or [])]


def weather(ident, lat, lon):
    """METAR/TAF for the airport, or for the nearest reporting station within 60 NM."""
    out = {"station": None, "distNM": 0, "metar": None, "taf": None}
    try:
        m = _awc(f"/api/data/metar?ids={ident}&format=json&taf=true&hours=2")
        if not m and lat is not None:
            near = sorted(((nm_between(lat, lon, s["lat"], s["lon"]), s) for s in memo("stations", _stations)), key=lambda x: x[0])
            for d, s in near[:6]:
                if d > 60:
                    break
                m = _awc(f"/api/data/metar?ids={s['icaoId']}&format=json&taf=true&hours=2")
                if m:
                    out["distNM"] = round(d, 1)
                    break
        if m:
            m = sorted(m, key=lambda x: x.get("obsTime") or 0)[-1]
            out["station"] = m.get("icaoId")
            out["metar"] = {k: m.get(k) for k in ("rawOb", "fltCat", "wdir", "wspd", "wgst", "visib", "altim", "temp",
                                                 "dewp", "clouds", "wxString", "reportTime", "lat", "lon", "elev", "name")}
            out["taf"] = m.get("rawTaf")
            if out["taf"]:
                # decoded TAF periods (FM / BECMG / TEMPO / PROB with times, visibility, clouds) for the timeline
                try:
                    t = _awc(f"/api/data/taf?ids={out['station']}&format=json")
                    if t:
                        t = sorted(t, key=lambda x: x.get("issueTime") or "")[-1]
                        out["tafValid"] = [t.get("validTimeFrom"), t.get("validTimeTo")]
                        out["tafFcsts"] = [{k: f.get(k) for k in ("timeFrom", "timeTo", "timeBec", "fcstChange", "probability",
                                                                   "wdir", "wspd", "wgst", "visib", "vertVis", "wxString", "clouds")}
                                           for f in t.get("fcsts") or []]
                except Exception as e:
                    print("decoded TAF unavailable:", e)
    except Exception as e:
        out["error"] = str(e)
    return out


# ---------------------------------------------------------------- terrain (Open-Meteo DEM)
_terrain_cache = {}


def terrain(locs):
    """locs: [(lat, lon)] -> elevations in metres from Open-Meteo (Copernicus DEM), retried."""
    key = tuple((round(a, 3), round(b, 3)) for a, b in locs)
    if key in _terrain_cache:
        return _terrain_cache[key]
    errors = []
    lat = ",".join(f"{a:.4f}" for a, _ in locs)
    lon = ",".join(f"{b:.4f}" for _, b in locs)
    for wait in (0, 1.5, 3):
        time.sleep(wait)
        try:
            d = json.loads(fetch(f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}", timeout=20))
            if "elevation" in d:
                out = {"source": "Open-Meteo (Copernicus DEM)", "elev": d["elevation"]}
                _terrain_cache[key] = out
                return out
            errors.append(d.get("reason", "Open-Meteo error"))
        except Exception as e:
            errors.append(str(e))
    raise RuntimeError("; ".join(dict.fromkeys(errors)))


# ---------------------------------------------------------------- SIDs / STARs (FAA NASR DP + STAR)
def _norm_proc(name):
    return re.sub(r"[^A-Z0-9]", "", re.sub(r"\((RNAV|OBSTACLE|RNAV\s*\d*)\)", "", name.upper()))


def _procedures():
    """index FAA id -> {"sids": [...], "stars": [...]}; each procedure has its exit / entry fixes with coordinates."""
    def build():
        fixes, navs, _ = _fixnav()

        def where(pid, near):
            c = [(f[0], f[1]) for f in fixes.get(pid, [])] + [(n[0], n[1]) for n in navs.get(pid, [])]
            if not c:
                return None
            return min(c, key=lambda q: nm_between(near[0], near[1], q[0], q[1])) if near else c[0]

        apt_pos = {}
        text = cached_file("airports.csv", OA + "airports.csv", 7 * DAY).decode("utf-8", "ignore")
        for a in csv.DictReader(io.StringIO(text)):
            xy = (num(a["latitude_deg"]), num(a["longitude_deg"]))
            if xy[0] is None:
                continue
            for k in (a["ident"], a.get("gps_code"), a.get("local_code"), a.get("icao_code")):
                if k:
                    apt_pos.setdefault(k, xy)

        def apt_xy(faa):
            return apt_pos.get("K" + faa) or apt_pos.get(faa) or apt_pos.get("P" + faa)

        idx = {}
        for kind, zipname, base_f, apt_f, code_k, name_k in (("sids", "DP", "DP_BASE.csv", "DP_APT.csv", "DP_COMPUTER_CODE", "DP_NAME"),
                                                             ("stars", "STAR", "STAR_BASE.csv", "STAR_APT.csv", "STAR_COMPUTER_CODE", "ARRIVAL_NAME")):
            z, _ = _nasr_zip(zipname)
            rd = lambda n: list(csv.DictReader(io.StringIO(z.read(n).decode("latin1"))))
            rwys = {}
            for r in rd(apt_f):
                rwys.setdefault((r[code_k], r["ARPT_ID"]), set()).add(r["RWY_END_ID"])
            trans = {}
            for r in rd(zipname + "_RTE.csv"):
                t = r["TRANSITION_COMPUTER_CODE"]
                if t:
                    trans.setdefault(r[code_k], set()).add(t)
            for b in rd(base_f):
                code = b[code_k]
                # SID "ACCRA5.FANZI": exits after the dot; STAR "AALAN.BLAID2": entries before the dot
                fix_of = (lambda c: c.split(".")[-1]) if kind == "sids" else (lambda c: c.split(".")[0])
                pts = {fix_of(code)} | {fix_of(t) for t in trans.get(code, ())}
                for faa in b["SERVED_ARPT"].split():
                    xy = apt_xy(faa)
                    ends = []
                    for f in sorted(pts):
                        w = where(f, xy)
                        if w and (not xy or nm_between(xy[0], xy[1], w[0], w[1]) < 400):
                            ends.append({"fix": f, "lat": round(w[0], 4), "lon": round(w[1], 4)})
                    rw = sorted(x for x in rwys.get((code, faa), set()) if x and x != "ALL")
                    idx.setdefault(faa, {"sids": [], "stars": []})[kind].append({
                        "name": f'{b[name_k]} {b["AMENDMENT_NO"]}'.strip(), "code": code, "rnav": b["RNAV_FLAG"] == "Y",
                        "type": b.get("GRAPHICAL_DP_TYPE") or "STAR", "runways": rw, "ends": ends, "key": _norm_proc(f'{b[name_k]} {b["AMENDMENT_NO"]}')})
        return idx
    return memo("procs", build)


def procedures(cands, country):
    if country != "US":
        return None
    try:
        idx = _procedures()
    except Exception as e:
        print("SID/STAR data unavailable:", e)
        return None
    for c in cands:
        for k in (c[1:] if len(c) == 4 and c[0] in "KP" else c, c):
            if k in idx:
                return idx[k]
    return {"sids": [], "stars": []}


# ---------------------------------------------------------------- published routes (FAA preferred / TEC / CDR)
def _awy_seqs():
    """every airway (V, J, Q, T, colored) as ordered point sequences [(id, lat, lon, mea)] for route-string expansion"""
    def build():
        fixes, navs, _ = _fixnav()
        za, _ = _nasr_zip("AWY")
        groups = {}
        for r in csv.DictReader(io.StringIO(za.read("AWY_SEG_ALT.csv").decode("latin1"))):
            groups.setdefault((r["AWY_LOCATION"], r["AWY_ID"]), []).append(r)
        seqs = {}
        for (loc, aid), rs in groups.items():
            rs.sort(key=lambda r: num(r["POINT_SEQ"], int) or 0)
            seq, prev = [], None
            for r in rs:
                pid = r["FROM_POINT"]
                c = [(f[0], f[1]) for f in fixes.get(pid, [])] + [(n[0], n[1]) for n in navs.get(pid, []) if n[4] not in ("VOT",)]
                if not c:
                    continue
                xy = min(c, key=lambda q: nm_between(prev[0], prev[1], q[0], q[1])) if prev else c[0]
                mea = max([v for v in (num(r["MIN_ENROUTE_ALT"], int), num(r["MIN_ENROUTE_ALT_OPPOSITE"], int)) if v] or [0]) or None
                seq.append((pid, xy[0], xy[1], mea))
                prev = xy
            if seq:
                seqs.setdefault(aid, []).append(seq)
        return seqs
    return memo("awyseqs", build)


def _proc_paths():
    """SID / STAR point sequences: {"sid": {code: {"body": [...], "trans": {fix: [...]}}}, "star": {...}}"""
    def build():
        out = {"sid": {}, "star": {}}
        for kind, zipname, code_k in (("sid", "DP", "DP_COMPUTER_CODE"), ("star", "STAR", "STAR_COMPUTER_CODE")):
            z, _ = _nasr_zip(zipname)
            rows = list(csv.DictReader(io.StringIO(z.read(zipname + "_RTE.csv").decode("latin1"))))
            grp = {}
            for r in rows:
                key = (r[code_k], r["ROUTE_PORTION_TYPE"], r["TRANSITION_COMPUTER_CODE"] or r["ROUTE_NAME"], r["BODY_SEQ"])
                grp.setdefault(key, []).append(r)
            for (code, portion, tname, bseq), rs in grp.items():
                rs.sort(key=lambda r: num(r["POINT_SEQ"], int) or 0)
                pts = [r["POINT"] for r in rs if r["POINT"]]
                d = out[kind].setdefault(code.split(".")[0] if kind == "sid" else code.split(".")[1], {"body": None, "trans": {}})
                if portion == "BODY":
                    if d["body"] is None:
                        d["body"] = pts
                else:
                    fix = tname.split(".")[1] if kind == "sid" else tname.split(".")[0]
                    d["trans"].setdefault(fix, pts)
        return out
    return memo("procpaths", build)


def _pfr_cdr():
    def build():
        zp, _ = _nasr_zip("PFR")
        pfr = {}
        for r in csv.DictReader(io.StringIO(zp.read("PFR_BASE.csv").decode("latin1"))):
            pfr.setdefault((r["ORIGIN_ID"], r["DSTN_ID"]), []).append(r)
        zc, _ = _nasr_zip("CDR")
        cdr = {}
        for r in csv.DictReader(io.StringIO(zc.read("CDR.csv").decode("latin1"))):
            cdr.setdefault((r["Orig"], r["Dest"]), []).append(r)
        return pfr, cdr
    return memo("pfrcdr", build)


AIRWAY_RE = re.compile(r"^(V|J|Q|T|A|B|G|R|Y|M|L|N|W)\d{1,4}$")
PROC_RE = re.compile(r"^[A-Z]{2,5}\d[A-Z]?$")


def _expand(tokens, start, end):
    """route-string tokens -> points [{id, lat, lon, kind, via, mea}] between the two airports"""
    fixes, navs, _ = _fixnav()
    seqs, procs = _awy_seqs(), _proc_paths()
    pts, unresolved, rnav = [], [], False
    sid_tok = star_tok = sid_trans = star_trans = None

    def locate(pid, near, far=None):
        c = [(f[0], f[1], "fix") for f in fixes.get(pid, [])] + [(n[0], n[1], "nav") for n in navs.get(pid, []) if n[4] != "VOT"]
        if not c:
            return None
        ref = near or far
        return min(c, key=lambda q: nm_between(ref[0], ref[1], q[0], q[1])) if ref else c[0]

    def add(pid, via=None, mea=None):
        here = (pts[-1]["lat"], pts[-1]["lon"]) if pts else start
        w = locate(pid, here, end)
        if not w:
            unresolved.append(pid)
            return
        if pts and pts[-1]["id"] == pid:
            return
        pts.append({"id": pid, "lat": round(w[0], 5), "lon": round(w[1], 5), "kind": w[2], "via": via, "mea": mea})

    toks = [t for t in tokens if t and t != "DCT"]
    i = 0
    while i < len(toks):
        t = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if AIRWAY_RE.match(t) and t in seqs and pts and nxt:
            if t[0] in "QTY":
                rnav = True
            a = pts[-1]["id"]
            done = False
            for seq in seqs[t]:
                ids = [q[0] for q in seq]
                if a in ids and nxt in ids:
                    ia, ib = ids.index(a), ids.index(nxt)
                    step = 1 if ib > ia else -1
                    for k in range(ia + step, ib + step, step):
                        q = seq[k]
                        mea = seq[k - 1][3] if step == 1 else q[3]
                        pts.append({"id": q[0], "lat": round(q[1], 5), "lon": round(q[2], 5),
                                    "kind": "nav" if q[0] in navs else "fix", "via": t, "mea": mea})
                    done = True
                    break
            if not done:
                add(nxt, via=t)
            i += 2
            continue
        if PROC_RE.match(t) and (t in procs["sid"] or t in procs["star"]):
            if not pts and t in procs["sid"]:          # SID right after the departure airport
                sid_tok, d = t, procs["sid"][t]
                sid_trans = nxt
                for pid in (d["body"] or []) + (d["trans"].get(nxt, []) if nxt else []):
                    add(pid, via=t)
                i += 1
                continue
            if t in procs["star"] and (i == len(toks) - 1):  # STAR just before the destination
                star_tok, d = t, procs["star"][t]
                star_trans = pts[-1]["id"] if pts else None
                for pid in (d["trans"].get(star_trans, []) if star_trans else []) + (d["body"] or []):
                    add(pid, via=t)
                i += 1
                continue
            i += 1
            continue
        add(t)
        i += 1
    return {"points": pts, "unresolved": unresolved, "rnav_airways": rnav, "sid": sid_tok, "sid_trans": sid_trans,
            "star": star_tok, "star_trans": star_trans}


def published_routes(o_cands, d_cands, o_xy, d_xy):
    pfr, cdr = _pfr_cdr()
    faa = lambda c: c[1:] if len(c) == 4 and c[0] in "KP" else c
    out, seen = [], set()
    for oc in o_cands:
        for dc in d_cands:
            for r in pfr.get((faa(oc), faa(dc)), []) + pfr.get((oc, dc), []):
                rs = r["ROUTE_STRING"].split()
                key = ("PFR", r["PFR_TYPE_CODE"], " ".join(rs), r["ALT_DESCRIP"])
                if key in seen:
                    continue
                seen.add(key)
                out.append({"src": "FAA preferred", "type": r["PFR_TYPE_CODE"], "route": " ".join(rs), "alt": r["ALT_DESCRIP"],
                            "aircraft": r["AIRCRAFT"], "hours": r["HOURS"], "dir": r["ROUTE_DIR_DESCRIP"], "area": r["SPECIAL_AREA_DESCRIP"],
                            "tokens": rs})
            for r in cdr.get((oc if len(oc) == 4 else "K" + oc, dc if len(dc) == 4 else "K" + dc), []):
                rs = r["Route String"].split()[1:-1]
                key = ("CDR", " ".join(rs))
                same = next((x for x in out if x["route"] == " ".join(rs)), None)
                if same:                       # identical to a preferred route: note the CDR code there instead
                    same["code"] = same.get("code") or r["RCode"]
                    continue
                if key in seen:
                    continue
                seen.add(key)
                out.append({"src": "Coded departure route", "type": "CDR", "code": r["RCode"], "route": " ".join(rs), "alt": "",
                            "aircraft": "", "navEqp": r["NavEqp"], "length": num(r["Length"], int), "tokens": rs})
    for r in out:
        e = _expand(r.pop("tokens"), o_xy, d_xy)
        r.update(e)
        r["rnav"] = e["rnav_airways"] or "RNAV" in (r.get("aircraft") or "").upper()
        pts = [o_xy] + [(q["lat"], q["lon"]) for q in e["points"]] + [d_xy]
        r["nm"] = round(sum(nm_between(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:])))
    return out


# ---------------------------------------------------------------- ICAO regions for flight-plan export
def _region_grid():
    def build():
        fixes, _, _ = _fixnav()
        grid = {}
        for fid, lst in fixes.items():
            for f in lst:
                if len(f) > 3 and f[3]:
                    grid.setdefault((int(f[0] // 1), int(f[1] // 1)), []).append((f[0], f[1], f[3]))
        return grid
    return memo("regiongrid", build)


def icao_regions(points):
    """points: [(ident, lat, lon)] -> ICAO region per point (FAA data: US and territories), None when unknown.
    A fix's own region when the ident is a FAA fix nearby, otherwise the region of the nearest FAA fix (for navaids)."""
    fixes, _, _ = _fixnav()
    grid = _region_grid()
    out = []
    for ident, lat, lon in points:
        reg = None
        own = [f for f in fixes.get(ident, []) if len(f) > 3 and f[3]]
        if own:
            f = min(own, key=lambda f: nm_between(lat, lon, f[0], f[1]))
            if nm_between(lat, lon, f[0], f[1]) < 30:
                reg = f[3]
        if reg is None:
            best = None
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for f in grid.get((int(lat // 1) + di, int(lon // 1) + dj), []):
                        d = nm_between(lat, lon, f[0], f[1])
                        if d < 60 and (best is None or d < best[0]):
                            best = (d, f[2])
            reg = best[1] if best else None
        out.append(reg)
    return out


def airport_info(ident, cands, country, lat, lon):
    return {"ident": ident, "runways": runways(cands), "freqs": frequencies(cands), "ils": ils(cands, country),
            "charts": charts(cands, country), "procs": procedures(cands, country), "wx": weather(ident, lat, lon)}


def warm():
    """Pre-load the big datasets in the background so the first lookup is fast."""
    def go():
        for f in (navaids_json, airways_json, _procedures, lambda: runways(["KSFO"]), lambda: frequencies(["KSFO"]),
                  lambda: ils(["KSFO"], "US"), lambda: ils(["EGLL"], "GB"), lambda: charts(["KSFO"], "US"),
                  lambda: memo("stations", _stations)):
            try:
                f()
            except Exception as e:
                print("warm-up:", e)
    threading.Thread(target=go, daemon=True).start()
