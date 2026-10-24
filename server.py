"""Local server for the Flight Performance Calculator.

Serves the app and the /api endpoints (airports, navaids, airways, routes, airport info, regions, terrain)
that navdata.py builds from public sources.

    python server.py            -> http://localhost:8765
"""
import csv
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
UA = "Mozilla/5.0 (flight-performance-calculator; personal use)"

OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
AIRPORT_TYPES = {"large_airport", "medium_airport", "small_airport", "seaplane_base"}


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
        if url.path == "/api/rwyindex":
            try:
                return self.send_json(200, navdata.runway_index())
            except Exception as e:
                return self.send_json(502, {"error": f"runway data unavailable: {e}"})
        if url.path == "/api/wxbulk":
            kind = urllib.parse.parse_qs(url.query).get("kind", [""])[0]
            if kind not in ("metars", "tafs"):
                return self.send_json(400, {"error": "kind must be metars or tafs"})
            try:
                return self.send_bytes(navdata.wx_bulk(kind), "application/gzip")
            except Exception as e:
                return self.send_json(502, {"error": f"weather data unavailable: {e}"})
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


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a.isdigit()]       # python server.py [port]
    port = int(args[0]) if args else int(os.environ.get("PORT", 8765))
    print(f"Flight Performance Calculator on http://localhost:{port}")
    navdata.warm()
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
