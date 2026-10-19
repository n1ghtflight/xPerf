"""Build data/to_ref.json (takeoff reference data per OpenAP type, read by toperf.js).

    python tools/build_to_ref.py <aircraft_data.xlsx>

<aircraft_data.xlsx> is the FAA Aircraft Characteristics Database
(https://www.faa.gov/airports/engineering/aircraft_char_database/aircraft_data, public domain).
Approach speed (VREF at MALW) per type; flap settings, labels and engine overrides are set below.
"""
import csv, io, json, os, re, sys, zipfile, xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def xlsx_rows(path):
    """First worksheet as a list of dicts (stdlib only)."""
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    col = lambda ref: sum((ord(ch) - 64) * 26 ** i for i, ch in enumerate(reversed(re.match(r"[A-Z]+", ref).group()))) - 1
    rows = []
    for row in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter("{%s}row" % NS["m"]):
        vals = {}
        for c in row.findall("m:c", NS):
            v = c.find("m:v", NS)
            vals[col(c.get("r"))] = "" if v is None else ss[int(v.text)] if c.get("t") == "s" else v.text
        if vals:
            rows.append([vals.get(i, "") for i in range(max(vals) + 1)])
    head = rows[0]
    return [dict(zip(head, r + [""] * (len(head) - len(r)))) for r in rows[1:]]


LB=0.45359237
rows={r['ICAO_Code'].strip():r for r in xlsx_rows(sys.argv[1])}
out=os.path.join(ROOT,'data','to_ref.json')
F=lambda *p:[{"name":n,"level":l} for n,l in p]
AIRBUS=F(("1+F","low"),("2","mid"),("3","high"))
fam={
 **{c:("airbus","FLEX",AIRBUS) for c in "a19n a20n a21n a318 a319 a320 a321 a332 a333 a343 a359 a388".split()},
 **{c:("boeing","Assumed temp",F(("1","low"),("5","mid"),("15","high"))) for c in "b37m b38m b39m b3xm b734 b737 b738 b739".split()},
 "b752":("boeing","Assumed temp",F(("5","low"),("15","mid"),("20","high"))),
 **{c:("boeing","Assumed temp",F(("5","low"),("15","mid"),("20","high"))) for c in "b763 b772 b773 b77w b788 b789".split()},
 **{c:("boeing","Assumed temp",F(("10","low"),("20","mid"))) for c in "b744 b748".split()},
 **{c:("embraer","TO temp",F(("1","low"),("2","mid"),("4","high"))) for c in "e170 e75l e190 e195".split()},
 "e145":("embraer","TO temp",F(("9","low"),("18","mid"))),
 "crj9":("bombardier","TO temp",F(("8","low"),("20","mid"))),
 "c550":("cessna","TO temp",F(("7","low"),("15","mid"))),
 "glf6":("gulfstream","TO temp",F(("10","low"),("20","mid"))),
}
types={}
for c,(family,label,flaps) in sorted(fam.items()):
    r=rows.get(c.upper()); e={"family":family,"label":label,"flaps":flaps}
    if r and r['Approach_Speed_knot']:
        malw=r['MALW_lb']
        try: malw=float(malw)*LB
        except ValueError: malw=None
        if c=="b739": malw=None   # FAA row lists 71,400 lb, an obvious unit/typo error; the model falls back to OpenAP MLW
        e["vrefMLW"]={"v":int(float(r['Approach_Speed_knot'])),"s":"pub","src":"FAA Aircraft Characteristics Database (Oct 2024)",
                      "ref":f"{r['ICAO_Code']} · {r['Model_FAA']} · Approach_Speed_knot"+(f" · MALW {r['MALW_lb']} lb" if malw else "")}
        e["malwKg"]=round(malw) if malw else None
    types[c]=e
# 737 MAX 10: no FAA row. Same wing as the MAX 9: scale its approach speed by sqrt(OpenAP MLW 70,000 kg / MAX 9 MALW).
b39=types["b39m"]; v=round(b39["vrefMLW"]["v"]*(70000/b39["malwKg"])**0.5)
types["b3xm"]["vrefMLW"]={"v":v,"s":"est","src":"B39M FAA approach speed scaled to B3XM landing weight","ref":"150 kt × √(70,000 / 74,344 kg); same wing as the 737 MAX 9"}
types["b3xm"]["malwKg"]=None
# takeoff engine where OpenAP's default is a low-thrust variant (OpenAP engines.csv values)
LEAP28={"name":"LEAP-1B28","thrustN":130400,"bpr":8.3,"src":"OpenAP engines.csv; 737-9/-10 at MTOW use the LEAP-1B28 rating (OpenAP's default 'LEAP-1B' resolves to the 21K LEAP-1B21)"}
types["b39m"]["engine"]=LEAP28; types["b3xm"]["engine"]=LEAP28
types["b788"]["engine"]={"name":"GEnx-1B70","thrustN":321600,"bpr":8.8,"src":"OpenAP engines.csv; one of the 787-8 options in OpenAP's b788.yml — the default Trent 1000-E2 is a low-rated short-haul variant"}
schema={"about":"Takeoff reference data per OpenAP type (toperf.js). Built from the FAA Aircraft Characteristics Database, downloaded 2026-10-18.",
 "vrefMLW":"approach speed (VREF) at the max landing weight malwKg (kt); s = pub (published) | est (estimated, see src/ref)",
 "malwKg":"the landing weight the approach speed applies to (FAA MALW); null = use OpenAP mlw",
 "flaps":"the type's most-used takeoff flap settings, one per model level (low/mid/high); from common public operator usage (recalled, not from a manual) — verify",
 "engine":"optional takeoff engine {name, thrustN per engine, bpr, src} replacing OpenAP's default for this model only","family":"naming family","label":"what the reduced-thrust temperature is called on this type"}
s=json.dumps({"_schema":schema,"types":types},indent=1,ensure_ascii=False)
open(out,"w",encoding="utf-8",newline="\r\n").write(s+"\n")
print(len(types),"types")
