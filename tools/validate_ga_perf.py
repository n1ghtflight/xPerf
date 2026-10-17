"""Validate data/ga_perf.json (XPerf's own GA / turboprop / business-jet performance table).

  python tools/validate_ga_perf.py            # checks + report (exit 1 on errors)
  python tools/validate_ga_perf.py --quiet    # checks only

Checks: all 82 types present; every value has a status and a source (or an estimation method);
units/ranges plausible; speed ordering (Vat < approach <= descent, Vat < cruise TAS, ...); engine
power inside the windows index.html uses to reject bad power figures. Then lists estimated fields per
type, types with weak sourcing, and — for a private sanity check only — compares against
apm_snapshot.json (EUROCONTROL) when present. Nothing from the snapshot is written anywhere.
"""
import json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
EXPECTED = ("B350 BE20 BE23 BE33 BE36 BE55 BE58 BE76 BE9L C150 C152 C172 C177 C182 C206 C207 C208 C210 C25A C25B "
            "C310 C337 C340 C402 C414 C421 C425 C441 C525 C560 C56X C680 C750 CL30 CL35 CL60 DA40 DA42 DA50 DHC6 "
            "DR40 E50P E55P F2TH F900 FA7X G115 GLEX GLF4 GLF5 HDJT LJ45 LJ60 M20P M20T M600 P180 P28A P28R P28T "
            "P32R P46T PA18 PA23 PA27 PA31 PA32 PA34 PA38 PA44 PA46 PC12 PC6T PRM1 RALL SR20 SR22 TAMP TBM7 TBM8 "
            "TOBA TRIN").split()
COMMON = ["takeOffMTOW", "takeOffDistance", "takeOffV2", "initialClimbIAS", "initialClimbROC", "cruiseTAS",
          "cruiseCeiling", "cruiseRange", "descentIAS", "descentROD", "approachIAS", "approachROD", "landingVat",
          "landingDistance"]
REQUIRED = {"piston": COMMON, "turboprop": COMMON + ["climb150IAS", "climb150ROC"],
            "jet": COMMON + ["climb150IAS", "climb150ROC", "climb240IAS", "climb240ROC", "machClimbMACH", "machClimbROC",
                             "cruiseMACH", "initialDescentMACH", "initialDescentROD"]}
# (min, max) by engine kind
RANGES = {
 "takeOffMTOW":     {"piston": (500, 4000), "turboprop": (1500, 8000), "jet": (3000, 50000)},
 "takeOffDistance": {"piston": (100, 1000), "turboprop": (100, 1300), "jet": (800, 2200)},
 "landingDistance": {"piston": (100, 1000), "turboprop": (100, 1300), "jet": (500, 1300)},
 "cruiseTAS":       {"piston": (80, 260), "turboprop": (100, 420), "jet": (340, 560)},
 "cruiseCeiling":   {"piston": (100, 320), "turboprop": (200, 420), "jet": (400, 520)},
 "cruiseRange":     {"piston": (250, 1500), "turboprop": (300, 2500), "jet": (1000, 7000)},
 "initialClimbROC": {"piston": (400, 2200), "turboprop": (800, 4000), "jet": (1500, 6000)},
 "landingVat":      {"piston": (40, 110), "turboprop": (50, 125), "jet": (90, 145)},
 "takeOffV2":       {"piston": (40, 110), "turboprop": (50, 130), "jet": (95, 150)},
 "descentROD":      {"piston": (300, 1500), "turboprop": (500, 3000), "jet": (1000, 4000)},
 "approachROD":     {"piston": (250, 1000), "turboprop": (300, 1200), "jet": (500, 1500)},
}
STATUSES = {"pub", "rec", "der", "est"}
G0, LB = 9.80665, 0.45359237

errors, warnings = [], []
def err(code, msg): errors.append(f"{code}: {msg}")
def warn(code, msg): warnings.append(f"{code}: {msg}")

def check_value(code, name, o, sources):
    if not isinstance(o, dict) or "v" not in o or o.get("s") not in STATUSES:
        err(code, f"{name}: missing value or status"); return False
    s = o["s"]
    if s in ("pub", "rec", "der"):
        if not o.get("src"): err(code, f"{name}: status {s} without source")
        for sid in o.get("src", []):
            if sid not in sources: err(code, f"{name}: unknown source id {sid!r}")
    if s in ("pub", "rec") and not o.get("ref"): err(code, f"{name}: no 'ref' (what the source says)")
    if s in ("der", "est") and not o.get("method"): err(code, f"{name}: {s} without method")
    m = o.get("method", "")
    if m.startswith("[") and m[1:m.index("]")] not in RULE_IDS: err(code, f"{name}: unknown rule {m[:m.index(']') + 1]}")
    return True

RULE_IDS = set()

def validate(data):
    types, sources = data.get("types", {}), data.get("sources", {})
    RULE_IDS.update(data.get("_schema", {}).get("rules", {}))
    for sid, s in sources.items():
        if not s.get("title") or s.get("kind") not in ("manufacturer", "poh", "magazine", "reference", "aggregator"):
            err("sources", f"{sid}: title/kind missing or invalid")
        if not s.get("url") and s.get("kind") != "aggregator": warn("sources", f"{sid}: no URL")
    missing = sorted(set(EXPECTED) - set(types)); extra = sorted(set(types) - set(EXPECTED))
    if missing: err("table", f"missing types: {' '.join(missing)}")
    if extra: warn("table", f"unexpected types: {' '.join(extra)}")

    for code in sorted(types):
        t = types[code]; e = t.get("engine", {}); kind = e.get("kind"); P = t.get("perf", {})
        if kind not in REQUIRED: err(code, f"engine.kind {kind!r} invalid"); continue
        for f in REQUIRED[kind]:
            if f not in P: err(code, f"missing perf.{f}")
        for f, o in P.items(): check_value(code, f, o, sources)
        for f in ("type", "wtc", "wingspan_m"): check_value(code, f, t.get(f), sources)
        pw = e.get("thrustKN") if kind == "jet" else e.get("hp")
        if not check_value(code, "engine power", pw, sources): continue
        v = lambda f: P[f]["v"] if f in P else None

        # ranges
        for f, rng in RANGES.items():
            x = v(f)
            if x is None: continue
            lo, hi = rng[kind]
            if not (lo <= x <= hi): err(code, f"{f} = {x} outside plausible {kind} range {lo}–{hi}")
        # designator / wake / engine consistency (the app reads engine count and kind from 'type')
        n = e.get("count")
        if t["type"]["v"] != f"L{n}{ {'piston': 'P', 'turboprop': 'T', 'jet': 'J'}[kind] }":
            err(code, f"type {t['type']['v']} disagrees with engine count/kind")
        mtow = v("takeOffMTOW")
        if t["wtc"]["v"] != ("L" if mtow <= 7000 else "M"): err(code, "wtc disagrees with MTOW")
        if e.get("fuel") not in ("avgas", "jet-a"): err(code, "engine.fuel must be avgas or jet-a")
        if e.get("diesel") and e.get("fuel") != "jet-a": err(code, "diesel engine must burn jet-a")
        # power windows used by index.html loadApmModel() before it falls back to an estimate
        p = pw["v"]
        if kind == "piston" and not (mtow * 0.06 / n <= p <= mtow * 0.35 / n): err(code, f"{p} hp outside app window for {mtow} kg")
        if kind == "turboprop" and not (mtow * 0.08 / n <= p <= mtow * 0.5 / n): err(code, f"{p} shp outside app window for {mtow} kg")
        if kind == "jet" and not (mtow * G0 * 0.12 / n <= p * 1000 <= mtow * G0 * 0.6 / n): err(code, f"{p} kN outside app window for {mtow} kg")
        span = t["wingspan_m"]["v"]
        if not (7 <= span <= 35): err(code, f"wingspan {span} m implausible")
        # speed ordering
        vat, app, des, tas, v2, vy = v("landingVat"), v("approachIAS"), v("descentIAS"), v("cruiseTAS"), v("takeOffV2"), v("initialClimbIAS")
        if not vat < tas: err(code, f"Vat {vat} not below cruise TAS {tas}")
        if not vat <= app: err(code, f"approach IAS {app} below Vat {vat}")
        if not app <= des + 5: err(code, f"approach IAS {app} above descent IAS {des}")
        if not vat * 0.75 <= v2 <= vat * 1.35: warn(code, f"V2/speed at 50 ft {v2} vs Vat {vat} looks odd")
        if not vat <= vy + 5 <= tas: err(code, f"initial climb IAS {vy} not between Vat {vat} and cruise TAS {tas}")
        if v("landingDistance") > 1.6 * v("takeOffDistance") and kind != "jet":
            warn(code, f"landing distance {v('landingDistance')} m much longer than takeoff {v('takeOffDistance')} m")
        if kind == "jet":
            m = v("cruiseMACH")
            if not 0.6 <= m <= 0.95: err(code, f"cruise Mach {m} implausible")
            if not 0.55 <= v("machClimbMACH") <= m: err(code, "Mach climb above cruise Mach")
            alt = (t.get("cruise") or {}).get("alt_ft")
            if not alt and abs(tas / 573.6 - m) > 0.03: err(code, f"cruise TAS {tas} and Mach {m} inconsistent")
            for a, b in (("initialClimbROC", "climb150ROC"), ("climb150ROC", "climb240ROC"), ("climb240ROC", "machClimbROC")):
                if v(b) > v(a): warn(code, f"{b} {v(b)} above {a} {v(a)}")
        if kind == "turboprop" and v("climb150ROC") > v("initialClimbROC"): warn(code, "climb150ROC above initialClimbROC")
        # fuel flow sanity: kg/h per rated hp (pistons/turboprops) 0.05–0.40
        ff = (t.get("fuel") or {}).get("cruise")
        if ff:
            check_value(code, "fuel.cruise.kgh", ff.get("kgh"), sources)
            if kind != "jet":
                r = ff["kgh"]["v"] / (p * n)
                if not 0.05 <= r <= 0.40: err(code, f"cruise fuel flow {ff['kgh']['v']} kg/h implausible for {n}×{p} hp")
        if t.get("sourcing") not in ("good", "fair", "weak"): err(code, "sourcing grade missing")

def report(data, snapshot):
    types = data["types"]
    counts = {s: 0 for s in ("pub", "rec", "der", "est")}
    for t in types.values():
        for o in list(t["perf"].values()) + [t["engine"].get("hp") or t["engine"].get("thrustKN"), t["wingspan_m"]]:
            counts[o["s"]] += 1
    total = sum(counts.values())
    print(f"\n== Values by status ({total} perf/engine/span values) ==")
    for s, c in counts.items(): print(f"  {s}: {c:4d}  ({100 * c / total:.0f}%)")
    grades = {}
    for c, t in types.items(): grades.setdefault(t["sourcing"], []).append(c)
    print("\n== Sourcing grade ==")
    for g in ("good", "fair", "weak"): print(f"  {g:4s} ({len(grades.get(g, [])):2d}): {' '.join(sorted(grades.get(g, [])))}")
    print("\n== Weak sourcing: reasons ==")
    for c in sorted(grades.get("weak", [])): print(f"  {c}: {'; '.join(types[c].get('sourcing_reasons', []))}")
    print("\n== Estimated (est) fields per type ==")
    for c in sorted(types):
        t = types[c]
        est = [f for f, o in t["perf"].items() if o["s"] == "est"]
        if t["wingspan_m"]["s"] == "est": est.append("wingspan_m")
        rec = [f for f, o in t["perf"].items() if o["s"] == "rec"] + (["engine"] if (t["engine"].get("hp") or t["engine"].get("thrustKN"))["s"] == "rec" else [])
        line = f"  {c}: est {', '.join(sorted(est)) or '—'}"
        if rec: line += f" | recalled (verify): {', '.join(sorted(rec))}"
        print(line)
    ff = [c for c, t in types.items() if t.get("fuel", {}).get("cruise")]
    print(f"\n== Published cruise fuel flow ({len(ff)} types) ==")
    for c in sorted(ff):
        f = types[c]["fuel"]["cruise"]
        print(f"  {c}: {f['kgh']['v']} kg/h — {f.get('setting')}" + (f", {f['alt_ft']:,} ft" if f.get("alt_ft") else "") + (f", {f['tas_kt']} KTAS" if f.get("tas_kt") else ""))

    if not snapshot:
        print("\n(apm_snapshot.json not found — EUROCONTROL sanity comparison skipped)"); return
    print("\n== Private sanity check vs apm_snapshot.json (EUROCONTROL) — report only, nothing copied ==")
    print("  type  field             ours  EUROCONTROL  diff   (|diff| > 35% shown; '*' = ours estimated)")
    fields = ["takeOffMTOW", "cruiseTAS", "cruiseCeiling", "cruiseRange", "initialClimbROC", "takeOffDistance",
              "landingDistance", "landingVat", "approachIAS", "descentIAS", "descentROD"]
    shown = 0
    for c in sorted(types):
        sp = (snapshot.get(c) or {}).get("perf", {})
        for f in fields:
            o = types[c]["perf"].get(f); x = sp.get(f)
            if not o or not x: continue
            d = (o["v"] - x) / x
            if abs(d) > 0.35:
                shown += 1
                print(f"  {c:5s} {f:16s} {o['v']:>6}{'*' if o['s'] == 'est' else ' '} {x:>10g}  {d:+5.0%}")
    print(f"  {shown} large differences. Take-off/landing distances are expected to differ: this table uses the "
          "POH distance over 50 ft, EUROCONTROL's GA values are closer to ground rolls.")

def main():
    path = os.path.join(ROOT, "data", "ga_perf.json")
    with open(path, encoding="utf-8") as f: data = json.load(f)
    validate(data)
    quiet = "--quiet" in sys.argv
    snap_path = os.path.join(ROOT, "apm_snapshot.json")
    snapshot = None
    if os.path.exists(snap_path):
        with open(snap_path, encoding="utf-8") as f: snapshot = json.load(f)
    if not quiet: report(data, snapshot)
    print(f"\n{len(data['types'])} types, {len(errors)} errors, {len(warnings)} warnings")
    for w in warnings: print("  warning:", w)
    for e in errors: print("  ERROR:", e)
    sys.exit(1 if errors else 0)

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
