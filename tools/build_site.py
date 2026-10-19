"""Build XPerf's static website (no Python server needed to run it).

    python tools/build_site.py                          -> dist/site/
    python tools/build_site.py --wx https://xperf-wx.<you>.workers.dev

Copies the app files index.html references, data/ga_perf.json + to_ref.json + to_tune.json, the current AIRAC pack (packs/current.json and
packs/<cycle>/), vendor/, icons/ and the web manifest. index.html is marked as a static build: data from the
packs, the METAR/TAF relay (--wx, see tools/wx-worker.js) and the service worker, whose version and precache
list are filled in here. Build the packs first: python build_packs.py
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "site"))
    ap.add_argument("--wx", default="", help="METAR/TAF relay URL (without it the hosted site shows no live weather)")
    a = ap.parse_args()
    if a.wx and not re.match(r"^https://[^\s\"<>]+$", a.wx):
        sys.exit("--wx must be an https:// URL")

    cur_path = os.path.join(ROOT, "packs", "current.json")
    if not os.path.exists(cur_path):
        sys.exit("no data packs: run  python build_packs.py  first")
    with open(cur_path, encoding="utf-8") as f:
        cur = json.load(f)

    with open(os.path.join(ROOT, "index.html"), encoding="utf-8", newline="") as f:
        page = f.read()
    # files the page loads by relative URL (scripts and stylesheets carry ?v=; precache them exactly as written)
    refs = sorted(set(m.group(1) for m in re.finditer(r'<(?:link\b[^>]*\bhref|script\b[^>]*\bsrc)="([^"#:${}]+)"', page)))

    out = os.path.abspath(a.out)
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    def copy(rel):
        src = os.path.join(ROOT, rel.split("?")[0])
        if not os.path.isfile(src):
            sys.exit(f"missing file referenced by the site: {rel}")
        dst = os.path.join(out, rel.split("?")[0])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)

    for r in refs:
        copy(r)
    for d in ("data/ga_perf.json", "data/to_ref.json", "data/to_tune.json"):
        copy(d)
    for d in ("vendor", "icons"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(out, d), dirs_exist_ok=True)
    os.makedirs(os.path.join(out, "packs"))
    shutil.copyfile(cur_path, os.path.join(out, "packs", "current.json"))
    shutil.copytree(os.path.join(ROOT, "packs", cur["path"]), os.path.join(out, "packs", cur["path"]))

    # mark the page as the static build
    def meta(name, value):
        nonlocal page
        new, n = re.subn(rf'<meta name="{name}" content="[^"]*">', f'<meta name="{name}" content="{value}">', page)
        if n != 1:
            sys.exit(f"index.html: expected one <meta name=\"{name}\">")
        page = new
    meta("xperf-data", "packs")
    meta("xperf-wx", a.wx)
    meta("xperf-sw", "sw.js")
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8", newline="") as f:
        f.write(page)

    # service worker: precache the app shell; its version changes whenever any shell file does
    shell = list(dict.fromkeys(["./"] + refs + ["data/ga_perf.json", "data/to_ref.json", "data/to_tune.json"] + sorted(
        os.path.relpath(os.path.join(dp, fn), out).replace(os.sep, "/")
        for d in ("vendor", "icons") for dp, _, fns in os.walk(os.path.join(out, d)) for fn in fns)))   # addAll rejects duplicates
    h = hashlib.sha256()
    for rel in ["index.html"] + shell[1:]:
        with open(os.path.join(out, rel.split("?")[0]), "rb") as f:
            h.update(rel.encode() + f.read())
    with open(os.path.join(ROOT, "sw.js"), encoding="utf-8") as f:
        sw = f.read()
    sw = sw.replace('"__VERSION__"', json.dumps(h.hexdigest()[:12])).replace("__PRECACHE__", json.dumps(shell))
    with open(os.path.join(out, "sw.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write(sw)

    # host hints: Cloudflare Pages / Netlify read _headers; GitHub Pages needs .nojekyll
    with open(os.path.join(out, "_headers"), "w", encoding="utf-8", newline="\n") as f:
        f.write("/packs/:cycle/*\n  Cache-Control: public, max-age=31536000, immutable\n"   # cycle files only, not current.json
                "/packs/current.json\n  Cache-Control: no-cache\n"
                "/sw.js\n  Cache-Control: no-cache\n"
                "/index.html\n  Cache-Control: no-cache\n")
    open(os.path.join(out, ".nojekyll"), "w").close()

    total = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(out) for fn in fns)
    files = sum(len(fns) for _, _, fns in os.walk(out))
    print(f"site: {out}\n  {files} files, {total / 1e6:.1f} MB · AIRAC {cur['cycle']} · "
          f"METAR/TAF relay: {a.wx or 'none (live weather unavailable)'} · service worker {h.hexdigest()[:12]}")


if __name__ == "__main__":
    main()
