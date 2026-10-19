"""Bring the hosted XPerf site to the current AIRAC cycle (every 28 days).

    python tools/airac_update.py --check     report: current cycle, local packs, live site (changes nothing)
    python tools/airac_update.py             if the site is behind: rebuild packs, rebuild the site, deploy, verify
    python tools/airac_update.py --force     rebuild and deploy even if everything is current
    python tools/airac_update.py --no-deploy rebuild locally only

Needs a one-time `npx wrangler login`. Deploys only dist/site, from a temporary folder with its own
wrangler.toml: never run `wrangler deploy` in the repo itself (it would publish the whole folder).
Site / relay / Worker name: --site, --wx, --name, or XPERF_SITE / XPERF_WX / XPERF_WORKER.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import navdata  # noqa: E402  (same cycle logic as build_packs.py)

# wrangler prints emoji; a cp1252 console (scheduled runs, pipes) would crash on them after the deploy
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SITE = os.environ.get("XPERF_SITE", "https://xperf.n1ghtflight.workers.dev")
WX = os.environ.get("XPERF_WX", "https://xperf-wx.n1ghtflight.workers.dev")
WORKER = os.environ.get("XPERF_WORKER", "xperf")


def local_cycle():
    try:
        with open(os.path.join(ROOT, "packs", "current.json"), encoding="utf-8") as f:
            return json.load(f)["cycle"]
    except (OSError, ValueError, KeyError):
        return None


def live_cycle(site):
    try:
        req = urllib.request.Request(site.rstrip("/") + "/packs/current.json?t=%d" % time.time(),
                                     headers={"Cache-Control": "no-cache", "User-Agent": "XPerf AIRAC update"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)["cycle"]
    except Exception as e:  # noqa: BLE001 — reported, not fatal for --check
        return f"unreachable ({e})"


def run(cmd, **kw):
    print("  $", " ".join(cmd), flush=True)
    p = subprocess.run(cmd, cwd=kw.pop("cwd", ROOT), text=True, encoding="utf-8", errors="replace", **kw)
    if p.returncode:
        sys.exit(f"failed ({p.returncode}): {' '.join(cmd)}")
    return p


def prune_packs(keep):
    base = os.path.join(ROOT, "packs")
    for d in sorted(os.listdir(base)):
        if re.fullmatch(r"\d{4}", d) and d not in keep:
            shutil.rmtree(os.path.join(base, d), ignore_errors=True)
            print(f"  removed old pack {d}")


def deploy(name, site_dir):
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx") or "npx"
    with tempfile.TemporaryDirectory(prefix="xperf-deploy-") as tmp:
        with open(os.path.join(tmp, "wrangler.toml"), "w", encoding="utf-8") as f:
            f.write(f'name = "{name}"\ncompatibility_date = "2026-10-01"\npreview_urls = false\nworkers_dev = true\n\n'
                    f'[assets]\ndirectory = "{site_dir.replace(os.sep, "/")}"\n')
        p = run([npx, "--yes", "wrangler@latest", "deploy"], cwd=tmp, capture_output=True)
    out = p.stdout + p.stderr
    m = re.search(r"Read (\d+) files from the assets directory (.+)", out)
    if not m or os.path.normcase(os.path.abspath(m.group(2).strip())) != os.path.normcase(site_dir):
        sys.exit("deploy did not read dist/site as its assets directory — check the output:\n" + out[-1500:])
    print("  " + "\n  ".join(l for l in out.splitlines() if re.search(r"Read \d+ files|Uploaded|https://|Version", l)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-deploy", action="store_true")
    ap.add_argument("--site", default=SITE)
    ap.add_argument("--wx", default=WX)
    ap.add_argument("--name", default=WORKER)
    a = ap.parse_args()

    eff, cyc = navdata.airac()
    loc, live = local_cycle(), live_cycle(a.site)
    print(f"AIRAC now: {cyc} (effective {eff}) · local packs: {loc or 'none'} · live site: {live}")
    if a.check:
        print("up to date" if loc == cyc == live else "update needed: python tools/airac_update.py")
        return
    if loc == cyc == live and not a.force:
        print("nothing to do")
        return

    if loc != cyc or a.force:
        print(f"building packs for AIRAC {cyc} …")
        run([sys.executable, "build_packs.py"])
        if local_cycle() != cyc:
            sys.exit(f"packs/current.json says {local_cycle()}, expected {cyc}")
        prune_packs({cyc, loc} - {None})
    print("building the site …")
    run([sys.executable, os.path.join("tools", "build_site.py"), "--wx", a.wx])
    if a.no_deploy:
        print("built dist/site (not deployed)")
        return
    print(f"deploying {a.name} …")
    deploy(a.name, os.path.join(ROOT, "dist", "site"))
    for _ in range(12):
        if live_cycle(a.site) == cyc:
            print(f"live site is on AIRAC {cyc}: {a.site}")
            return
        time.sleep(5)
    sys.exit(f"deployed, but {a.site} still reports {live_cycle(a.site)}")


if __name__ == "__main__":
    main()
