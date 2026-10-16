# XPerf on the iOS App Store — portability study

Written 2026-10-16. Findings come from the code (index.html, nav.js, charts.js, pln.js, acpicker.js, server.py,
navdata.py), from live checks against each data host (CORS headers, payload sizes), and from a phone-width
(375 px) run of SR22 KSBA→KSFO on a test instance. Effort and cost figures are **estimates**.

---

## 1. Bottom line

**It can be done, and most of the app carries over. Data licences and Apple's rule against "web wrapper"
apps are the hard parts, not the code.**

- **Recommended path:** a **Capacitor** shell (WKWebView) running the existing JS UI, plus a **build pipeline**
  that turns `navdata.py` output into prebuilt, versioned **data packs** (one per AIRAC cycle) served from a
  static CDN. Live weather and terrain are fetched on the device through Capacitor's native HTTP, which avoids
  CORS. **No Python runs on the phone and no app server is needed.**
- **Before spending on the Store:** ship the same build as a **PWA** (installable from Safari with "Add to Home
  Screen") for yourself and a few testers. It costs nothing, needs no review, and checks the iPhone/iPad UX first.
- **Licence blockers to fix before any public release, whether free or paid:**
  1. EUROCONTROL APM is scraped from a website whose terms forbid redistribution without written permission.
  2. Open-Meteo's free tier is **non-commercial only**.
  3. OSM tile servers forbid offline use and may block apps.
  4. X-Plane `nav.dat` (non-US ILS) comes from GPL-licensed data.
  5. Using the "Microsoft Flight Simulator" name needs care.
- **A personal question to settle first:** the project files are owned by a `REDMOND` domain account. If you
  work at Microsoft, check its outside-business-activity and IP rules before publishing a paid app built around a
  Microsoft product.

---

## 2. What exists today and where each piece goes on iOS

About 3,600 lines in total. **Almost all of the compute is already client-side JS** (ISA/geo math, `planProfile`
level optimisation, VOR/NDB Dijkstra, airway router, takeoff/landing performance, charts, .PLN XML). Python
does two jobs only: (a) download, parse and cache public datasets, and (b) proxy hosts that send no CORS headers.

| Today (server.py / navdata.py) | Size / behaviour (measured) | On iOS |
|---|---|---|
| `/api/airports` (OurAirports, 49k) | 3.96 MB raw · **1.4 MB gzip** | Data pack (bundled at first install, then updated) |
| `/api/navaids` | 1.03 MB · **339 KB gzip** | Data pack |
| `/api/airways` (NASR AWY) | 0.83 MB · **185 KB gzip** | Data pack (per AIRAC) |
| `/api/airportinfo` (runways, freqs, ILS, d-TPP charts, SID/STAR, METAR/TAF) | ~17 KB per airport (KSFO) | **Split.** Static parts go into a data pack, sharded by ICAO prefix. METAR/TAF are fetched live on the device |
| `/api/routes` (PFR/TEC/CDR expanded) | built from about 2.6 MB of NASR zips | Pipeline expands the routes, and the pack holds an index keyed by origin/destination |
| `/api/regions` (ICAO region grid) | grid built from airports | Pack holds the grid; the lookup is ported to JS (small) |
| `/api/terrain` (Open-Meteo, then OpenTopoData fallback) | live | Device fetch (Open-Meteo has CORS). A fallback needs a commercial source (§4) |
| `/api/apm/<ICAO>` (EUROCONTROL scrape) | live HTML scrape, no CORS, Cloudflare in front | **Has to change.** See §4 |
| d-TPP metafile (16 MB XML) | parsed server-side | Pipeline only; the pack keeps chart name→URL per airport |
| OpenAP files (GitHub raw / jsDelivr) | live, CORS OK | Bundle a pinned copy in the app (LGPL data, small) |
| Leaflet 1.9.4 from cdnjs | live | Bundle locally (BSD-2). Apps should not depend on a CDN at launch |

**Conclusion:** `navdata.py` stays in Python as the **pipeline**: a scheduled job every 28 days, e.g. GitHub
Actions. Only the small lookups the UI makes at run time get ported to JS. That is roughly 150–250 lines
(**estimate**), not a rewrite of the 750-line parser. The full data set gzips to roughly **3–6 MB (estimate)** with
airport shards, so offline use is realistic.

---

## 3. Options compared

| | A. PWA | **B. Capacitor + data packs (recommended)** | C. Capacitor + hosted API (port server.py to the cloud) | D. Native SwiftUI rewrite |
|---|---|---|---|---|
| Code reuse | ~95 % | ~85 % | ~90 % | ~10 % (logic must be re-coded in Swift) |
| App Store | no (Home-Screen install) | yes | yes | yes |
| Apple 4.2 "web wrapper" risk | n/a | medium. Needs real native value (§5) | **high**: a thin client over a website | low |
| Offline in the cockpit | partial (service worker) | **yes** | no | yes |
| Running cost | static hosting + a CORS proxy | static CDN (near free) | an always-on server that you maintain, plus rate limits shared by all users at one IP | static CDN |
| CORS-less hosts (AWC, aeronav, EUROCONTROL) | need a proxy | native HTTP on the device | server proxy | native |
| Effort to first TestFlight (**estimate**) | 3–5 days | **3–5 weeks** | 2–4 weeks | 3–5 months |

Why not C: all users would share one server IP. aviationweather.gov caps traffic at **100 requests/minute**, and
the server would also have to be run and paid for. Why not D: the value of XPerf is in its tuned JS logic (level
optimisation, routers, terrain, pickers). Re-deriving that in Swift costs months and adds new bugs. **React Native**
has the same problem as D for the logic and gains nothing over B, because the UI is HTML/SVG/Leaflet already.

---

## 4. Data and licensing (the real gate)

| Source | Licence / terms | Store-ready? | Action |
|---|---|---|---|
| OurAirports (airports, runways, freqs, navaids) | Public domain | ✅ | Credit it |
| FAA NASR (AWY, FIX, NAV, ILS, DP, STAR, PFR, CDR) | US Gov public domain | ✅ | Show the AIRAC cycle and "not for real navigation" |
| FAA d-TPP plates | US Gov public domain | ✅ | Link to aeronav PDFs, or cache them on the device |
| aviationweather.gov METAR/TAF | Public. **100 req/min**, custom User-Agent requested, **no CORS** | ✅ through native HTTP | Send one request per airport set from each device, never from a shared server |
| Open-Meteo winds aloft + elevation | Free tier is **non-commercial only**. Paid plans (1M / 5M / 50M+ calls per month) carry the commercial licence; prices not published on the page | ⚠️ for a paid, ad-supported or IAP app | Free app with no ads/IAP: arguably fine, but confirm with them by email. Paid app: buy Standard, or self-host Open-Meteo (open-source) |
| OpenTopoData public API (terrain fallback) | 1,000 calls/day, not meant for apps | ❌ | Drop it. Ship a coarse terrain grid in the pack instead (e.g. GLOBE/SRTM, public domain), which also gives offline terrain |
| **EUROCONTROL APM** (82 GA/bizjet types + any-ICAO lookup) | Website content: no redistribution or commercial use without written permission. Cloudflare-fronted, no CORS | ❌ **as it stands** | (1) Ask EUROCONTROL for permission, or (2) replace with your own table built from public POH/type-certificate numbers, labelled with its source, or (3) keep the live lookup as an opt-in, on-device "fetch from EUROCONTROL" that the user triggers, with no redistribution. Option (3) is a grey area, so ask first |
| OpenAP (airliners, WRAP) | LGPL-3.0 (repo). Data "from open literature" | ✅ probably | Bundle the data files unmodified, keep the licence and credit. Pin a version |
| X-Plane `nav.dat` via OpenAP (non-US ILS, 2013) | Derived from X-Plane GPL nav data | ❌ GPL vs App Store terms are a known conflict | Drop it. Non-US ILS then shows "see chart", or use OurAirports navaids plus `navaids.csv` ILS-DME entries where they exist |
| OSM tiles / OpenTopoMap | Tile policy: apps need a unique User-Agent, **no offline/prefetch**, may be blocked without notice | ❌ for an app at scale | Use Apple MapKit JS (free quota), or MapTiler/Stadia vector tiles (paid above the free tier), or self-host Protomaps PMTiles (free, works offline) |
| ChartFox / SkyVector | links only | ✅ | Keep them as outbound links |
| "Microsoft Flight Simulator", "FS2024" | Microsoft trademarks. Game Content Usage Rules forbid commercial use of game content without a licence. Apple 4.1/5.2 forbid third-party names in the app name or icon without approval | ⚠️ | Name it **XPerf**, with no MSFS logo or screenshots of the sim. In the description only, say "exports .PLN flight plans compatible with Microsoft Flight Simulator 2024" (nominative use) |

**Legal disclaimer in the app:** "For flight simulation only. Not for real-world navigation." Show it at first
launch and in Settings, and put it in the Store description. This matters for Apple's 1.4 (physical harm) review
and for liability.

---

## 5. Apple review risk and how to clear it

1. **4.2 Minimum functionality (the main risk).** Apple rejects apps that are "a repackaged website".
   Features that make XPerf clearly app-like:
   - **Offline data packs** with an AIRAC update banner. Per 4.2.3(ii), disclose the download size before fetching.
   - **.PLN to the Files app / share sheet / AirDrop / iCloud Drive**, and a "Recent plans" library.
   - **iPad kneeboard mode**: Split View/Slide Over next to the sim stream, a large-type nav log, a night palette.
   - **Native PDF plate viewer (PDFKit)** with pinch zoom and plates cached for the flight.
   - Haptics on picker choices and a native settings screen. Optional later: a home-screen widget showing the
     next leg or current METAR.
2. **2.5.2 Code download.** Ship all JS inside the bundle. Data packs are data, so they're fine. Don't
   live-update the JS outside review (Capacitor live updates are tolerated only for small fixes; avoid them at first).
3. **4.2.3(i) Must work without another app.** It does: planning, briefings and the nav log are useful on their
   own. A future SimConnect bridge (§7) must stay optional.
4. **5.1 Privacy.** No accounts, no tracking. Add a privacy manifest (`PrivacyInfo.xcprivacy`) and declare
   "Data Not Collected". Use location only if a "nearest airport" feature is added.
5. **4.1 / 5.2 Trademarks.** See §4.

---

## 6. Technical changes for iOS (from the code)

| Area | Today | Change | Size (**est.**) |
|---|---|---|---|
| Data loading | `fetch('/api/...')` in index.html, nav.js, pln.js. `HAS_SERVER` gate disables routing without the server | One `data.js` adapter: packs from the file system/IndexedDB, live calls through `CapacitorHttp`. Same function signatures, so callers barely change. Routing works with no server | 3–4 days |
| Pipeline | `navdata.py` builds JSON on request | `build_packs.py` reuses navdata.py, writes `packs/<AIRAC>/…json.gz` and a manifest with hashes. Runs on a GitHub Actions cron every 28 days | 3–5 days |
| Aircraft-switch race (found in this study) | `calculate()` uses the global `MODEL`, which `selectModel()` sets asynchronously. Pressing Calculate while "loading performance data…" shows plans the **previous** aircraft (seen: SR22 card shown, B752 model used → "FL280") | `calculate()` awaits the pending `selectModel` promise, or disables **Calculate** until it resolves. A slower mobile network makes this more likely | 0.5 day (worth doing now, on desktop too) |
| .PLN export | `Blob` + `<a download>` (pln.js:112) | Capacitor Filesystem writes the file, then the Share plugin opens the share sheet → Files/AirDrop/iCloud. Remember the last folder | 1 day |
| Plates | `<iframe src=pdf#view=FitV>` (nav.js:743). WKWebView in an iframe shows the PDF with poor zoom | Native PDFKit modal via a small plugin, or bundle pdf.js | 1–2 days |
| Hover-only info | Map dots, cruise-level chart, winds layer and TAF timeline say "hover for details" | Tap to show a sticky tooltip, tap elsewhere to clear. Change the copy to "tap" on touch | 1–2 days |
| Phone layout | Measured at 375 px: **no horizontal page scroll** (good). Page heights after a plan: Setup 4.4k px, Route 2.9k, **Airports 6.2k**, Profile 3.3k, Fuel 3.3k. The form plus aircraft card sit *above* the results (about 1.5 screens before the first number) | iPhone: the form collapses to a one-line summary after Calculate, a bottom tab bar replaces the sticky top tabs, and the Airports tab gets DEP / ARR / ALTN sub-tabs (already on the open-items list). iPad: the current two-column layout fits as is | 4–6 days |
| Storage | `localStorage` (`xperf.*` keys) | iOS may evict WKWebView storage. Move it to Capacitor Preferences behind the same tiny wrapper | 0.5 day |
| Map | Leaflet + OSM/OpenTopoMap raster | Keep Leaflet with a licensed tile source (§4). Offline: PMTiles of the route corridor | 2–3 days |
| Clipboard | `navigator.clipboard` (nav.js:694) | Works in WKWebView on a user tap. Add a haptic | — |
| Safe areas / dark | Already a dark theme | `env(safe-area-inset-*)` paddings, status-bar style, and a launch screen | 0.5 day |
| Performance | A full plan took about 4 s on a desktop in the test (mostly network: weather, terrain, airport info) | With packs, only METAR/TAF and winds go to the network. The `planProfile` compute is light for an A-series chip. Show a progress state per fetch | — |

**Total to a TestFlight build: about 3–5 focused weeks (estimate)**, plus Apple review cycles.

---

## 7. Fit for the product (worth deciding consciously)

- FS2024 runs on **PC and Xbox**, not iOS. On iPhone/iPad XPerf is a **planner and kneeboard**. The .PLN file still
  has to reach the PC, via iCloud Drive for Windows, OneDrive or email. **Xbox players can't load .PLN files**, so
  for them the value is the briefing and nav log only.
- **iPad first** is the natural target: a kneeboard next to the sim, with the current layout fitting almost
  unchanged. iPhone is the secondary target (quick briefing and weather).
- Later differentiator: an optional **XPerf Bridge** for Windows that reads SimConnect and pushes the aircraft's
  position, fuel and the active leg over the LAN to the app (iOS Local Network permission). That gives a live
  moving map, fuel-versus-plan and auto leg sequencing. It strengthens the 4.2 case a lot and stays optional.
- Competition: SimBrief + Navigraph (subscription, much richer data), Little Navmap (desktop, free), plus
  ForeFlight/Garmin Pilot, which simmers use against real charts. XPerf's angle is **free/public data, GA-friendly,
  terrain-aware level optimisation, non-GPS VOR/NDB routing and a one-tap FS2024 setup card**. That combination
  is distinctive.

---

## 8. Costs (**estimates**, as of Oct 2026)

| Item | Cost |
|---|---|
| Apple Developer Program | US$99/year |
| A Mac to build/sign | Not needed if you use a cloud build: GitHub Actions macOS runners (free minutes on public repos, paid on private), Codemagic or Ionic Appflow free tiers. A Mac or Mac-in-cloud makes debugging with Xcode/Safari Web Inspector much easier, and a used Mac mini is the cheapest long-term option |
| Data hosting (packs, ~5 MB per AIRAC) | Effectively free (GitHub Pages / Cloudflare R2 free tier) |
| Map tiles | Free with self-hosted PMTiles or MapKit JS. Otherwise free tiers, then usage-based |
| Open-Meteo | Free if non-commercial. A paid plan is needed if the app is paid or has ads/IAP (price on request from their API Plans page) |
| EUROCONTROL | Free if permission is granted. Otherwise your time to build the replacement table (about 1 week) |

---

## 9. Suggested plan

> **Status 2026-10-16:** decided **free app, iPad first**. Phase 0 is done: `data.js` adapter + `build_packs.py`
> (AIRAC 2610 packs, 12.6 MB gzipped, airport info/routes/regions identical to the server). The aircraft-switch
> race fix was done in a separate session. The app runs fully from a static host with `?data=packs`; only live
> METAR/TAF needs native HTTP or the local server.

0. **Now (desktop, helps either way):** fix the aircraft-switch race. Put `fetch('/api/…')` behind one `data.js`
   adapter, which is a no-op change for the desktop app.
1. **Week 1–2: pipeline + packs.** Write `build_packs.py` with a manifest, and switch the desktop app to read
   packs too, so there is one code path. Drop X-Plane nav.dat and OpenTopoData. Pick a map tile source.
2. **Week 2: PWA.** Add a manifest and service worker, put a small CORS proxy (Cloudflare Worker) in front of AWC,
   and install it on your iPad/iPhone. Fly real sessions (SR22 KSBA→KSFO, B738 KATL→KBOS, C172 MROC→MRJO) and
   fix touch/hover and phone-layout issues.
3. **Week 3–4: Capacitor.** Add the iOS shell, native HTTP (the proxy is no longer needed), the share sheet for .PLN,
   PDFKit plates, Preferences storage, a first-launch disclaimer, and the privacy manifest. TestFlight to a few
   simmers.
4. **Licences in parallel:** email EUROCONTROL (APM reuse) and Open-Meteo (non-commercial confirmation or a plan).
   Settle the employer question if it applies.
5. **Store submission:** name "XPerf – Flight Sim Planner", "simulation only" wording, iPad screenshots of the
   setup card, profile chart and map.
6. **Later:** XPerf Bridge (SimConnect → LAN), widgets, iCloud sync of saved plans, Android (the Capacitor build is
   almost free once iOS works).

---

## 10. Decisions for you

1. **Free or paid / IAP?** This decides the Open-Meteo plan and how strict the EUROCONTROL question becomes.
2. **iPad-first or iPhone-first?** (Recommended: iPad first.)
3. **EUROCONTROL:** ask for permission, or build your own GA performance table?
4. **Mac:** do you have one, or should we go cloud-build only?
5. **Employer policy:** confirm that publishing is allowed, if it applies.

### Sources
- Apple App Store Review Guidelines — https://developer.apple.com/app-store/review/guidelines/
- Open-Meteo terms — https://open-meteo.com/en/terms · pricing — https://open-meteo.com/en/pricing
- OSM tile usage policy — https://operations.osmfoundation.org/policies/tiles/
- OpenAP (LGPL-3.0) — https://github.com/TUDelft-CNS-ATM/openap
- aviationweather.gov Data API (rate limits, no CORS) — https://aviationweather.gov/data/api/
- Xbox Game Content Usage Rules — https://www.xbox.com/en-US/developers/rules
- EUROCONTROL data terms (related research repository) — https://www.eurocontrol.int/publication/eurocontrol-aviation-data-repository-research-terms-use
