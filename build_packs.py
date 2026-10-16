"""Build offline data packs for XPerf, one set per AIRAC cycle.

    python build_packs.py            -> packs/<cycle>/... and packs/current.json
    python build_packs.py --xplane   -> also non-US ILS from X-Plane nav.dat (GPL: personal builds only, not for the App Store)

A pack holds the data the server's /api endpoints return, precomputed with the same navdata.py code, so the app
can run without the Python server (PWA / iOS). Live data (METAR/TAF, winds aloft, terrain) is still fetched at
run time; see data.js. Files are gzipped JSON; packs/<cycle>/files.json lists sizes and SHA-256 for updaters.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import time

import navdata
import server

ROOT = os.path.dirname(os.path.abspath(__file__))
FORMAT = 1


def shard_of(ident):
    """airport-info shard: first two characters of the ident (data.js uses the same rule)"""
    return re.sub(r"[^A-Z0-9]", "_", ident[:2].upper()).ljust(2, "_")


class Writer:
    def __init__(self, base):
        self.base, self.files = base, {}

    def put(self, rel, obj):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, separators=(",", ":")).encode()
        gz = gzip.compress(body, 9, mtime=0)
        path = os.path.join(self.base, rel + ".gz")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(gz)
        self.files[rel + ".gz"] = {"bytes": len(gz), "raw": len(body), "sha256": hashlib.sha256(gz).hexdigest()}


def client_cands(row):
    """the identifiers the app sends for an airport row: [ident, iata, ...aliases] (nav.js fetchAirportInfo)"""
    ident, iata, aliases = row[0], row[7], row[8] or []
    return [ident] + [c for c in [iata] + aliases if c and re.fullmatch(r"[A-Z0-9-]{2,8}", c.upper())]


def airport_shards(w, rows, xplane):
    shards = {}
    for row in rows:
        ident, country = row[0], (row[5] or "").upper()
        cands = [c.upper() for c in client_cands(row)]
        rec = {}
        r = navdata.runways(cands)
        if r:
            rec["r"] = r
        f = navdata.frequencies(cands)
        if f:
            rec["f"] = f
        if country == "US" or xplane:
            i = navdata.ils(cands, country)
            if i["list"]:
                rec["i"] = i["list"]
        c = navdata.charts(cands, country)
        if c and c["list"]:
            rec["c"] = [[x["code"], x["name"], x["url"].rsplit("/", 1)[1]] for x in c["list"]]
        p = navdata.procedures(cands, country)
        if p and (p["sids"] or p["stars"]):
            rec["p"] = p
        if rec:
            shards.setdefault(shard_of(ident), {})[ident] = rec
    for k, v in shards.items():
        w.put(f"apt/{k}.json", v)
    return sorted(shards), sum(len(v) for v in shards.values())


def route_shards(w, rows):
    """published routes for every origin/destination pair the FAA lists, computed exactly as /api/routes would
    answer for the app's own airport identifiers"""
    pfr, cdr = navdata._pfr_cdr()
    faa = lambda c: c[1:] if len(c) == 4 and c[0] in "KP" else c
    tiers, by_id = ({}, {}, {}), {}
    for row in rows:
        by_id[row[0]] = row
        ident = row[0].upper()
        for c in client_cands(row):
            c = c.upper()
            t = 0 if c == ident else 1 if c == (row[7] or "").upper() else 2
            for k in {c, faa(c), c if len(c) == 4 else "K" + c}:
                tiers[t].setdefault(k, set()).add(row[0])
    # the airport whose own ident matches the FAA code wins over an IATA match, which wins over a keyword alias
    # (e.g. Banyuwangi WADY lists "BWI" among its OurAirports keywords; the server would match it too)
    owners = lambda k: tiers[0].get(k) or tiers[1].get(k) or tiers[2].get(k, ())
    pairs = set()
    for (o, d) in list(pfr) + list(cdr):
        for oi in owners(o):
            for di in owners(d):
                if oi != di:
                    pairs.add((oi, di))
    out, n = {}, 0
    for oi, di in sorted(pairs):
        o, d = by_id[oi], by_id[di]
        routes = navdata.published_routes([c.upper() for c in client_cands(o)], [c.upper() for c in client_cands(d)],
                                          (o[2], o[3]), (d[2], d[3]))
        if routes:
            out.setdefault(oi, {})[di] = routes
            n += len(routes)
    for oi, v in out.items():
        w.put(f"routes/{re.sub(r'[^A-Z0-9-]', '_', oi.upper())}.json", v)
    return sorted(out), len(pairs), n


def fix_regions(w):
    fixes, _, _ = navdata._fixnav()
    out = {}
    for fid, lst in fixes.items():
        pts = [[round(f[0], 4), round(f[1], 4), f[3]] for f in lst if len(f) > 3 and f[3]]
        if pts:
            out[fid] = pts
    w.put("fixregions.json", out)
    return len(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(ROOT, "packs"))
    ap.add_argument("--xplane", action="store_true", help="include non-US ILS from X-Plane nav.dat (GPL, 2013)")
    a = ap.parse_args()

    eff, cyc = navdata.airac()
    base = os.path.join(a.out, cyc)
    tmp = base + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    w = Writer(tmp)
    t0 = time.time()
    step = lambda s: print(f"[{time.time() - t0:6.1f}s] {s}", flush=True)

    step(f"AIRAC {cyc} (effective {eff})")
    airports = server.get_airports()
    rows = json.loads(airports)
    w.put("airports.json", airports)
    step(f"airports: {len(rows)}")
    w.put("navaids.json", navdata.navaids_json())
    w.put("airways.json", navdata.airways_json())
    step("navaids, airways")
    shards, napt = airport_shards(w, rows, a.xplane)
    step(f"airport info: {napt} airports in {len(shards)} shards")
    origins, npairs, nroutes = route_shards(w, rows)
    step(f"published routes: {nroutes} routes, {len(origins)} origins ({npairs} airport pairs checked)")
    nfix = fix_regions(w)
    step(f"ICAO regions: {nfix} fixes")
    w.put("stations.json", [[s["icaoId"], round(s["lat"], 4), round(s["lon"], 4)] for s in navdata._stations()])
    step("METAR stations")

    nasr = navdata.memo("nasr_ils", navdata._nasr_ils)
    dtpp = navdata.memo("dtpp", navdata._dtpp)
    manifest = {
        "format": FORMAT, "cycle": cyc, "eff": eff.isoformat(),
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "xplane": a.xplane,
        "ils": {"us": {"source": f"FAA NASR, cycle effective {nasr['cycle']}", "current": True},
                "other": ({"source": "X-Plane nav.dat (GPL), AIRAC 2013.10 — frequencies/courses may have changed", "current": False}
                          if a.xplane else
                          {"source": "no free, current ILS data outside the US — see the approach chart", "current": False})},
        "charts": {"cycle": dtpp["cycle"], "eff": dtpp["eff"], "base": f"https://aeronav.faa.gov/d-tpp/{dtpp['cycle']}/"},
        "aptShards": shards, "routeOrigins": origins,
        "sources": {"airports, runways, frequencies, navaids": "OurAirports (public domain)",
                    "airways, fixes, ILS, SID/STAR, preferred routes, CDR": "FAA NASR 28-day subscription (public domain)",
                    "charts": "FAA d-TPP (public domain)", "METAR stations": "aviationweather.gov"},
    }
    total = sum(f["bytes"] for f in w.files.values())
    with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"))
    with open(os.path.join(tmp, "files.json"), "w", encoding="utf-8") as f:
        json.dump({"cycle": cyc, "bytes": total, "files": w.files}, f, separators=(",", ":"))
    shutil.rmtree(base, ignore_errors=True)
    os.replace(tmp, base)
    with open(os.path.join(a.out, "current.json"), "w", encoding="utf-8") as f:
        json.dump({"cycle": cyc, "eff": eff.isoformat(), "path": cyc + "/"}, f)
    big = sorted(w.files.items(), key=lambda kv: -kv[1]["bytes"])[:6]
    step(f"wrote {len(w.files)} files, {total / 1e6:.1f} MB gzipped -> {base}")
    for k, v in big:
        print(f"    {k:28s} {v['bytes'] / 1e3:8.0f} KB gz  ({v['raw'] / 1e3:.0f} KB raw)")


if __name__ == "__main__":
    sys.exit(main())
