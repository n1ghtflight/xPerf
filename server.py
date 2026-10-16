"""Local server for the Flight Performance Calculator.

Serves the app and proxies the EUROCONTROL Aircraft Performance Database
(which has no CORS headers, so a browser can't fetch it directly).

    python server.py            -> http://localhost:8765
    python server.py --snapshot -> refresh apm_snapshot.json (offline fallback)
"""
import csv
import html
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import navdata

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(ROOT, "cache")
CACHE_TTL = 30 * 86400
APM_URL = "https://learningzone.eurocontrol.int/ilp/customs/ATCPFDB/details.aspx?ICAO={}"
UA = "Mozilla/5.0 (flight-performance-calculator; personal use)"

# general aviation, turboprop and business types offered in the app's list
GA_TYPES = """C150 C152 C172 C177 C182 C206 C207 C208 C210 C310 C337 C340 C402 C414 C421 C425 C441
P28A P28R P28T P32R PA18 PA23 PA27 PA31 PA32 PA34 PA38 PA44 PA46 P46T M600 SR20 SR22 DA40 DA42 DA50
DR40 BE23 BE33 BE36 BE55 BE58 BE76 BE20 B350 BE9L M20P M20T TOBA TRIN TAMP RALL G115 PC12 PC6T TBM7 TBM8
DHC6 P180 C25A C25B C525 C560 C56X C680 C750 E50P E55P PRM1 HDJT LJ45 LJ60 CL30 CL35 CL60 GLF4 GLF5 GLEX FA7X F2TH F900""".split()

OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRPORT_TYPES = {"large_airport", "medium_airport", "small_airport", "seaplane_base"}


def fetch_apm(icao):
    req = urllib.request.Request(APM_URL.format(icao), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        page = r.read().decode("utf-8", "ignore")
    return parse_apm(icao, page)


def parse_apm(icao, page):
    def label(id_):
        m = re.search(r'id="MainContent_%s"[^>]*>([^<]*)' % id_, page)
        return html.unescape(m.group(1)).strip() if m else None

    perf = {}
    for key, val in re.findall(r'datagraph="(\w+)"[^>]*>([^<]*)<', page):
        v = html.unescape(val).strip()
        if not v or v in ("-", "no data"):
            continue
        try:
            perf[key] = float(v)
        except ValueError:
            perf[key] = v
    got = label("wsICAOLabel")
    if not got or got.upper() != icao:
        raise LookupError(f"{icao} not found in EUROCONTROL Aircraft Performance Database")
    return {
        "icao": icao,
        "name": label("wsAcftNameLabel"),
        "manufacturer": label("wsManufacturerLabel"),
        "type": label("wsTypeLabel"),          # e.g. L1P = landplane, 1 engine, piston
        "wtc": label("wsWTCLabel"),
        "powerplant": label("wsLabelPowerPlant"),
        "wingspan": label("wsLabelWingSpan"),
        "accommodation": label("wsLabelAccommodation"),
        "perf": perf,
        "source": APM_URL.format(icao),
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def get_apm(icao):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"apm_{icao}.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = fetch_apm(icao)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def get_airports():
    """OurAirports (public domain), slimmed to [ident, name, lat, lon, elev_ft, country, city, iata, aliases]."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, "airports_v2.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 7 * 86400:
        with open(path, "rb") as f:
            return f.read()
    req = urllib.request.Request(OURAIRPORTS_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8", "ignore")
    rows = []
    for a in csv.DictReader(io.StringIO(text)):
        if a["type"] not in AIRPORT_TYPES:
            continue
        ident = a.get("icao_code") or a.get("gps_code") or a["ident"]
        # other identifiers people may type: ident, GPS/local codes, former codes listed in keywords (e.g. KPBI -> KDJT)
        kw = [k.strip().upper() for k in (a.get("keywords") or "").split(",")]
        aliases = {c for c in [a["ident"], a.get("gps_code"), a.get("local_code")] + kw if c and re.fullmatch(r"[A-Z0-9]{3,4}", c)}
        aliases.discard(ident)
        try:
            rows.append([ident, a["name"], round(float(a["latitude_deg"]), 5), round(float(a["longitude_deg"]), 5),
                         int(float(a["elevation_ft"] or 0)), a["iso_country"], a["municipality"], a["iata_code"], sorted(aliases)])
        except ValueError:
            continue
    body = json.dumps(rows, separators=(",", ":")).encode()
    with open(path, "wb") as f:
        f.write(body)
    return body


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        m = re.match(r"^/api/apm/([A-Za-z0-9]{2,4})$", self.path)
        if m:
            icao = m.group(1).upper()
            try:
                self.send_json(200, get_apm(icao))
            except LookupError as e:
                self.send_json(404, {"error": str(e)})
            except Exception as e:  # network errors etc.
                self.send_json(502, {"error": f"EUROCONTROL fetch failed: {e}"})
            return
        if self.path == "/api/airports":
            try:
                body = get_airports()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_json(502, {"error": f"OurAirports fetch failed: {e}"})
            return
        url = urllib.parse.urlparse(self.path)
        if url.path == "/api/navaids":
            try:
                return self.send_bytes(navdata.navaids_json())
            except Exception as e:
                return self.send_json(502, {"error": f"navaid data unavailable: {e}"})
        if url.path == "/api/airways":
            try:
                return self.send_bytes(navdata.airways_json())
            except Exception as e:
                return self.send_json(502, {"error": f"airway data unavailable: {e}"})
        if url.path == "/api/routes":
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            ok = lambda c: re.fullmatch(r"[A-Z0-9]{2,6}", c)
            oc = [c for c in q.get("orig", "").upper().split(",") if ok(c)]
            dc = [c for c in q.get("dest", "").upper().split(",") if ok(c)]
            try:
                oxy = (float(q["olat"]), float(q["olon"]))
                dxy = (float(q["dlat"]), float(q["dlon"]))
                return self.send_json(200, {"routes": navdata.published_routes(oc, dc, oxy, dxy)})
            except Exception as e:
                return self.send_json(502, {"error": f"route data unavailable: {e}"})
        if url.path == "/api/regions":
            q = urllib.parse.parse_qs(url.query).get("pts", [""])[0]
            try:
                pts = []
                for item in q.split("|")[:400]:
                    ident, lat, lon = item.split(",")
                    pts.append((re.sub(r"[^A-Z0-9]", "", ident.upper())[:6], float(lat), float(lon)))
                return self.send_json(200, {"regions": navdata.icao_regions(pts)})
            except Exception as e:
                return self.send_json(400, {"error": f"bad region request: {e}"})
        if url.path == "/api/airportinfo":
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            ident = q.get("ident", "").upper()
            if not re.fullmatch(r"[A-Z0-9-]{2,8}", ident):
                return self.send_json(400, {"error": "bad ident"})
            cands = [ident] + [c for c in q.get("aliases", "").upper().split(",") if re.fullmatch(r"[A-Z0-9-]{2,8}", c)]
            try:
                lat, lon = float(q.get("lat")), float(q.get("lon"))
            except (TypeError, ValueError):
                lat = lon = None
            try:
                return self.send_json(200, navdata.airport_info(ident, cands, q.get("country", "").upper(), lat, lon))
            except Exception as e:
                return self.send_json(502, {"error": f"airport data unavailable: {e}"})
        if url.path == "/api/terrain":
            q = urllib.parse.parse_qs(url.query).get("locs", [""])[0]
            try:
                locs = [tuple(float(v) for v in p.split(",")) for p in q.split("|") if p][:300]
                return self.send_json(200, navdata.terrain(locs))
            except Exception as e:
                return self.send_json(503, {"error": f"terrain unavailable: {e}"})
        if self.path == "/api/health":
            return self.send_json(200, {"ok": True})
        super().do_GET()

    def end_headers(self):
        # always revalidate the app files so an update shows up on a normal reload
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_bytes(self, body, ctype="application/json"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def build_snapshot():
    out = {}
    for icao in GA_TYPES:
        try:
            out[icao] = get_apm(icao)
            print("ok  ", icao, out[icao]["name"])
        except Exception as e:
            print("FAIL", icao, e)
        time.sleep(0.3)
    with open(os.path.join(ROOT, "apm_snapshot.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(out)} types to apm_snapshot.json")


if __name__ == "__main__":
    if "--snapshot" in sys.argv:
        build_snapshot()
    else:
        args = [a for a in sys.argv[1:] if a.isdigit()]       # python server.py [port]
        port = int(args[0]) if args else int(os.environ.get("PORT", 8765))
        print(f"Flight Performance Calculator on http://localhost:{port}")
        navdata.warm()
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
