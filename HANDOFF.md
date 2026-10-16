# XPerf — Flight Performance & Route Planner for FS2024 · handoff

Written 2026-10-16 to continue work in a new chat. Read this first, then the code.

## What it is

A local web app that plans a flight for Microsoft Flight Simulator 2024 from **aircraft + departure + arrival**:
cruise level optimisation, climb/descent profile, TOC/TOD, fuel, non-GPS navigation (VOR/NDB/DME,
US Victor/Jet airways, FAA published routes), departure/arrival briefings with SID/STAR/approach selection and
FAA plates, live weather, terrain, charts, and a **.PLN export** for the FS2024 world map.
Everything is free/public data fetched live and cached locally. For simulation/education only.

## Run

```bash
cd C:\FlightSim\XPerf
python server.py          # http://localhost:8765  (python server.py 8770 for a second/test instance)
python server.py --snapshot   # refresh apm_snapshot.json (offline EUROCONTROL fallback)
```

- **After any change to `server.py` / `navdata.py` the user must restart the server.** Static files (html/js) are
  served with `Cache-Control: no-cache`; script tags carry `?v=…` version strings — bump them when editing a JS file.
- First run downloads ~40 MB of FAA/OurAirports data into `cache/` (a few seconds each); later runs are instant.
- Python 3.14 stdlib only (no pip packages). Node 24 is available for syntax checks.
- The user usually runs their own server on **8765**. For testing, start a separate instance on **8770**
  (`.claude/launch.json` points at 8770; the preview tool sometimes uses a stale config — starting
  `python -u server.py 8770` in the background and navigating the browser pane to it is reliable).

## Files

| File | Role |
|---|---|
| `index.html` (~1250 lines) | UI, styles, ISA/geo math, aircraft models (OpenAP airliners + EUROCONTROL APM GA/bizjets), weather/terrain fetch, level optimisation (`planProfile`), `calculate()`, `render()` with tabs, profile SVG |
| `nav.js` (~930) | Navaids, VOR/NDB route planner, airway router (+ hybrid for non-US ends), published-route client, nav log, Leaflet map, airport briefs/cards, runway/takeoff/landing performance, minimums, setup card (FS2024), departure briefing, SID/STAR/approach pickers + suggestions, plate viewer |
| `charts.js` (~210) | Winds-aloft layer, cruise-level chart, runway diagram, distance bars, fuel-remaining chart, TAF timeline |
| `acpicker.js` (~110) | Searchable aircraft combobox over the hidden `#ac` select |
| `pln.js` (~125) | FS2024 `.PLN` (AceXML) export |
| `data.js` (~200) | **Data adapter `XD`** — every data request goes through it. Mode `server` (default): the `/api` endpoints. Mode `packs` (`?data=packs`, `localStorage xperf.data=packs`, or the future iOS app): offline AIRAC packs + live Open-Meteo; METAR/TAF via native HTTP (iOS) or the local server if one answers. Contains JS ports of `navdata.weather` and `icao_regions` |
| `build_packs.py` | Pipeline: `python build_packs.py` → `packs/<AIRAC>/` (gzipped JSON, ~20 s, ~12.6 MB) + `packs/current.json`. Same navdata.py code, so results match the server exactly (checked: airport info, routes, regions). X-Plane non-US ILS left out unless `--xplane` (GPL). Rebuild each AIRAC |
| `packs/` | Built data packs (safe to delete; rebuild) |
| `IOS_PORT_STUDY.md` | iOS App Store portability study (Capacitor + packs, licences, plan) |
| `tools/check_weather_port.mjs` | Node check: data.js `weather()` vs server `/api/airportinfo` wx (needs server on 8770 + static on 8771) |
| `server.py` | Stdlib HTTP server + API endpoints (below), EUROCONTROL scraper |
| `navdata.py` (~750) | All data loading/parsing/caching: navaids, runways, frequencies, ILS, d-TPP charts, METAR/TAF, terrain, FAA airways, SID/STAR, preferred/CDR routes, ICAO regions |
| `apm_snapshot.json` | Offline snapshot of 82 EUROCONTROL GA/bizjet types |
| `cache/` | Downloaded datasets (safe to delete; re-downloaded) |
| `NUL` | Stray curl error output — safe to delete |

## API endpoints (server.py)

`/api/apm/<ICAO>` EUROCONTROL perf · `/api/airports` OurAirports (49k) · `/api/navaids` · `/api/airways` (V/J/colored) ·
`/api/airportinfo?ident&aliases&country&lat&lon` (runways, freqs, ILS, charts, SID/STAR procs, METAR/TAF + decoded TAF) ·
`/api/terrain?locs=lat,lon|…` · `/api/routes?orig&dest&olat&olon&dlat&dlon` (FAA preferred/TEC/CDR expanded to waypoints) ·
`/api/regions?pts=id,lat,lon|…` (ICAO regions for .PLN) · `/api/health`

## Data sources

- **Performance**: OpenAP (TU Delft, GitHub raw) for 37 airliners/large jets incl. WRAP ADS-B climb/descent stats;
  EUROCONTROL Aircraft Performance Database (scraped via server, no CORS) for 82 GA/turboprop/bizjet types + any ICAO
  lookup. GA fuel flow is **estimated** from engine power × generic SFC (no free fuel data). A few engine ratings are
  hand-corrected in `ENGINE_FIX` (index.html).
- **Airports/navaids/runways/frequencies**: OurAirports (public domain).
- **FAA NASR 28-day CSV** (current AIRAC via `navdata.airac()`, ref cycle 2610 = 2026-10-01): ILS, FIX, NAV, AWY, DP, STAR, PFR, CDR.
- **FAA d-TPP** metafile → official plate PDFs (US only); embedded directly from aeronav.faa.gov.
- **ILS outside US**: X-Plane GPL nav.dat via OpenAP (2013 — flagged as possibly outdated).
- **Weather**: aviationweather.gov METAR/TAF (+ decoded TAF, nearest station ≤60 NM); Open-Meteo winds/temps aloft
  (retries; was overloaded once). **Terrain**: Open-Meteo elevation, fallback OpenTopoData SRTM90 (server proxy).
- Map tiles: OpenStreetMap (CSS dark filter) + OpenTopoMap. CARTO needs an API key now — don't use.

## Features (current state)

- **Form**: searchable aircraft (remembered), departure/arrival/alternate (ICAO/IATA/local/aliases), navigation mode
  (Direct · VOR to VOR · VOR+NDB · Airways US · Published routes FAA), ETD, payload/TOW, extra fuel, level rules
  (IFR/VFR/Any), optimise fuel/time, manual level, no-O₂ 12,500 ft limit (unpressurised). Form column is sticky.
- **Level optimisation** (`planProfile`): simulates every candidate level; checks ceiling, buffet (airliners), terrain
  clearance along the whole profile (VFR 1,000 / IFR 2,000 over mountains, tapering near airports), airway MEA,
  oxygen; retries steeper GA descents when terrain/MEA clip; falls back step-by-step (any level → ignore route limits)
  with a warning instead of a hard error.
- **Navigation**: VOR/NDB Dijkstra with AIM service volumes; FAA airways router with MEA/MOCA/COP, international ends
  planned VOR-to-VOR to the first US airway fix; published routes (picker, suggestion by aircraft class/altitude,
  TEC altitude locked, SID/STAR taken from the route).
- **Results UI**: warnings + key numbers, then **tabs** (remembered): FS2024 setup · Route · Airports · Profile ·
  Fuel & levels. Setup card sections 1–5 are collapsible (remembered, expand/collapse all):
  1 world map/EFB (incl. flight rules, route type, fuel to load, **.PLN download**), 2 departure briefing (runway
  picker, SID/ODP picker with suggestion + plates), 3 cockpit (altimeter, COM/NAV/ADF, HDG, AP, XPDR),
  4 leg-by-leg radio log, 5 arrival briefing (STAR + approach pickers, ILS/minimums, plate viewer).
- **Airport cards**: summary strip, METAR + TAF timeline (ETD/ETA verdict), runway diagram + distance bars,
  runway table, ILS + std CAT I minimums, charts (in-app viewer), frequencies, radio aids.
- **.PLN export**: FPType/RouteType/CruisingAlt, airports with runways, waypoints with airways, ICAO region
  (FAA for US, nearest-airport prefix elsewhere, else user waypoint), SID/STAR idents, approach type.

## Conventions / gotchas

- Edit large JS/HTML blocks with a Python replace script written to a file (e.g. `cache/_edit.py`) and run via
  PowerShell — bash heredocs with backticks/quotes broke several times. Assert each replacement matches exactly once.
- Windows `MAX_PATH`: don't run scripts from the long scratchpad path; copy to `cache/` first.
- **Never call `/api/...` directly from the UI** — add/extend a function on `XD` in data.js (server and packs branch) so
  the iOS/PWA build keeps working. Test packs mode with `?data=packs` on 8770 (server as weather fallback) and on a
  plain static host (`python -m http.server 8771` → `http://localhost:8771/?data=packs`, no API: weather shows
  "Live weather unavailable"). A 404 for `/api/health` there is the expected probe.
- Several JS/py files use CRLF line endings — replace scripts must normalise `\n` → `\r\n` (see `cache/_edit_xd.py`).
- Syntax-check after edits: `node -e "new Function(require('fs').readFileSync('nav.js','utf8'))"` and the inline
  `<script>` blocks of index.html.
- `navdata.memo` uses an **RLock** (builders call other memoised builders — a plain Lock deadlocked).
- Runway ids differ between sources ("7L" vs "07L") → always compare with `rwyKey()`.
- Leaflet must be drawn when its tab is visible (`showTab` draws the map on first Route tab open).
- Headless screenshots: `tools/shoot.mjs` drives Edge over CDP (`$env:XPORT=8770; node tools\shoot.mjs <outDir> <width> <acId> <dep> <arr> <nav> [alt]`, run from PowerShell);
  the browser pane is narrow, so use it for full-resolution layout review.
- localStorage keys: `xperf.ac`, `xperf.tab`, `xperf.sec.N`, `xperf.winds`, `xperf.detlog`, `xperf.map`,
  `xperf.deprwy.ICAO`, `xperf.sid.ICAO`, `xperf.star.ICAO`, `xperf.appr.ICAO`, `xperf.pub.DEP-ARR`.

## Known limits / open items

- **.PLN not yet confirmed inside FS2024** — ask the user for feedback (waypoints dropped? SID/STAR/approach ignored?)
  and adjust tags (`DepartureFP`, `ArrivalFP`, `ApproachTypeFP`, `RunwayNumberFP/DesignatorFP`, `ICAORegion`).
- Free official plates/procedures are **US only**; elsewhere ChartFox/SkyVector links + visual/ILS approach options.
- Published routes only exist between larger US airports; small fields fall back to airways.
- Minimums shown are the standard CAT I baseline; real DA/MDA only on the plate.
- GA fuel and some EUROCONTROL climb rates (e.g. C172 400 fpm) are conservative/estimated.
- Airports tab is long with three airports — possible next step: departure/arrival sub-tabs or side-by-side.
- Ideas not done: SimBrief-style route string import, METAR-based runway-in-use from ATIS, alternate fuel,
  STAR/SID geometry drawn on the map for non-published routes, aircraft V-speeds per weight.
- The user's server on 8765 may still be running older code until they restart it.

## User preferences seen in this chat

- Flies FS2024; wants **visual, glanceable** output (charts liked, e.g. the profile/terrain graph), minimal scrolling,
  suggested defaults with the option to override (SID/STAR/approach/route), and real data rather than made-up numbers.
- Tests with GA (C172/C182/SR22) in Costa Rica (MROC/MRJO) and California, and airliners (B738/B752/B789) on US routes.
