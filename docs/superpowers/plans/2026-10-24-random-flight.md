# Random Flight Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Random flight" panel on the start screen that, for the aircraft the owner picks, finds 5 flyable flights
matching live day/night, departure and arrival weather and a distance band, and plans the one they click.

**Architecture:** Two worldwide aviationweather.gov cache files (METAR CSV, TAF XML) reach the browser through `XD`
(relay route in packs mode, `server.py` endpoint in server mode), plus a new per-AIRAC runway index. A new
`random.js` holds pure functions (parsing, weather classes, sun elevation, screening, ranking) and a thin UI layer;
picking an option reuses the start-screen example flow in `chips.js`.

**Tech Stack:** Vanilla JS (classic scripts, no build), Python 3.14 stdlib, Cloudflare Worker, `node --test`, Edge/CDP
UI harness.

**Spec:** `docs/superpowers/specs/2026-10-24-random-flight-design.md`

## Global Constraints

- No new dependencies, no build step; Python stdlib only.
- All UI data access through `XD` in `data.js` — never `fetch('/api/…')` from UI code.
- Bump `?v=` on every changed script/style tag in `index.html`. Preserve CRLF in files that use it (edit via a
  Python replace script that asserts each match once and normalises `\n` ↔ `\r\n`).
- Restart the 8770 test server after editing `.py` files.
- Calculations unchanged: `node tools/regress.mjs compare --port 8770` must stay **6/6 identical**.
- Never `wrangler deploy` inside the repo; deploy only from an isolated temp folder with an explicit `wrangler.toml`.
- House style: existing tokens/classes (`.seg`, `.card`, flight-category colours), light and dark, phone width.
- No Linear name or assets.
- Values pinned by the spec: **5** options; Short **20 min – 2 h**, Long **> 2 h to range**, Any **20 min to range**;
  departure report fresh within **90 min**; arrival uses the TAF when the estimate is **> 90 min**; Day = sun **> 0°**,
  Night = sun **< −6°**; ETD = now rounded **up to the next 10 min**; bulk weather cached **5 min**;
  `localStorage` key **`xperf.random`**; GA = `apm:` types, Airliner = `oap:` types.

## Review Focus

1. **Stale fixture clock** — METAR/TAF fixtures are hours old, so any code using `Date.now()` directly rejects every
   station; every pure function takes `now` (ms) as a parameter and the UI reads `RandomFlight.now()`, which tests
   override. Pinned in Task 4 (`generate` with fixture time) and Task 6 (UI check sets `RandomFlight.now`).
2. **Departure = arrival or the same field under two idents** — an option must never fly to its own departure or an
  airport within 5 NM of it. Test in Task 5.
3. **No relay configured / relay down** — the panel must say live weather search needs the site's relay or the local
   server, and offer Retry; it must not hang on "loading". Test in Task 6 (`XD.wxBulk` rejecting).
4. **Weather strings with vicinity or recent groups** (`VCSH`, `RERA`, `BLSN`, `-FZDZ`) — `VC`/`RE` groups are not
   weather at the field; `BLSN` (blowing snow) is not snowfall; `FZDZ` is rain. Test in Task 4.
5. **Aircraft with no range or runway data** (a GA type missing `cruiseRange` or `takeOffDistance`) — fall back to a
   conservative default rather than offering nothing or everything. Test in Task 5.

---

### Task 1: Relay serves the two worldwide files

**Files:**
- Modify: `tools/wx-worker.js`
- Test: `tests/wx-worker.test.mjs`

**Interfaces:**
- Produces: `GET <relay>/data/cache/metars.cache.csv.gz` and `GET <relay>/data/cache/tafs.cache.xml.gz` → the upstream
  bytes unchanged, `Content-Type: application/gzip`, `Cache-Control: public, max-age=300`, CORS as today. Any query
  string is dropped. Existing `/api/data/metar|taf` behaviour unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/wx-worker.test.mjs` (the existing `fetch` mock returns JSON; add a
  per-test mock returning bytes `[0x1f,0x8b,1,2,3]`):
  - `relays the worldwide METAR file byte for byte`: `ask("/data/cache/metars.cache.csv.gz?x=1")` → status 200,
    `calls[0].url === "https://aviationweather.gov/data/cache/metars.cache.csv.gz"`, body bytes deep-equal
    `[0x1f,0x8b,1,2,3]`, `Content-Type` `application/gzip`, `Access-Control-Allow-Origin` `*`.
  - `relays the worldwide TAF file`: same for `/data/cache/tafs.cache.xml.gz`.
  - `still refuses other cache files`: `ask("/data/cache/pireps.cache.csv.gz")` → 404, `calls.length === 0`.
- [ ] **Step 2:** `node --test tests/wx-worker.test.mjs` → the three new tests FAIL (404).
- [ ] **Step 3: Implement** a `FILES` set of the two paths, checked before `ROUTES`; fetch `UPSTREAM + pathname` with
  the same User-Agent, read `arrayBuffer()` (not `text()`), same edge-cache pattern. Update the header comment and the
  404 message to list the new paths.
- [ ] **Step 4:** `node --test tests/wx-worker.test.mjs` → all PASS.
- [ ] **Step 5: Commit** `git add tools/wx-worker.js tests/wx-worker.test.mjs` — "Relay: the two worldwide METAR/TAF
  cache files".

### Task 2: Runway index and bulk weather on the server and in the packs

**Files:**
- Modify: `navdata.py` (new `runway_index()`, `wx_bulk(kind)`), `server.py` (two endpoints), `build_packs.py`
  (write `rwyidx.json`)

**Interfaces:**
- Produces:
  - `navdata.runway_index() -> dict[str, list[int]]`: airport ident → `[longestFt, longestPavedFt, lit]` over open
    runways (`lit` 1 if any lighted runway). Paved = surface matches the same pattern as `SURF_PAVED` in `nav.js`
    (`ASP|CON|PEM|BIT|TAR|PAV|ASF|CONC|BRI|MAC`, case-insensitive). Airports with no runway rows are omitted. Memoised.
  - `navdata.wx_bulk(kind: str) -> bytes` for `kind in ("metars","tafs")`: the raw `.gz` bytes, cached 300 s via
    `cached_file`.
  - `GET /api/rwyindex` → JSON of `runway_index()`; `GET /api/wxbulk?kind=metars|tafs` → the bytes,
    `Content-Type: application/gzip`, 400 for any other kind.
  - Packs: `packs/<cycle>/rwyidx.json.gz` written by `build_packs.py` (`w.put("rwyidx.json", navdata.runway_index())`).

- [ ] **Step 1: Implement** the two navdata functions and the endpoints, following the existing `url.path ==` blocks.
- [ ] **Step 2: Verify** — restart the 8770 server, then:
  `curl -s localhost:8770/api/rwyindex | python -c "import json,sys;d=json.load(sys.stdin);print(len(d),d['KSFO'],d['00AK'])"`
  → about 40k+ entries, `KSFO` ≈ `[11870, 11870, 1]`, `00AK` = `[2500, 0, 0]`;
  `curl -s "localhost:8770/api/wxbulk?kind=metars" | python -c "import gzip,sys;print(gzip.decompress(sys.stdin.buffer.read())[:8])"`
  → `b'raw_text'`; `kind=x` → HTTP 400.
- [ ] **Step 3:** `python build_packs.py` → `packs/<cycle>/rwyidx.json.gz` exists (~0.3–0.6 MB).
- [ ] **Step 4:** `node tools/regress.mjs compare --port 8770` → 6/6 identical.
- [ ] **Step 5: Commit** `navdata.py server.py build_packs.py` — "Runway index and worldwide weather files for the
  random flight generator".

### Task 3: `XD` adapter calls

**Files:**
- Modify: `data.js` (returned object), `index.html` (`?v=` for data.js)

**Interfaces:**
- Consumes: Task 1 relay paths, Task 2 endpoints and `rwyidx.json`.
- Produces:
  - `XD.runwayIndex(): Promise<Record<string,[number,number,number]>>` — server `/api/rwyindex`, packs
    `pack("rwyidx.json")`; memoised with `once`.
  - `XD.wxBulk(kind: "metars"|"tafs"): Promise<string>` — decompressed text. Server mode `/api/wxbulk?kind=`;
    packs mode `WX + "/data/cache/" + (kind==="metars"?"metars.cache.csv.gz":"tafs.cache.xml.gz")`, else the local
    server via `proxy()`, else reject with `Error("live weather search needs the site's weather relay or the local
    server")`. Inflate when the first bytes are `1f 8b` (same check as `gunzipJSON`), otherwise decode as text.
    Cached in memory for 300 000 ms per kind.

- [ ] **Step 1: Implement** both calls next to `airports`/`airportInfo`.
- [ ] **Step 2: Verify** in the browser pane on `http://localhost:8770/` (server mode) and
  `http://localhost:8770/?data=packs` with a local relay absent: `await XD.runwayIndex()` has `KSFO`;
  `(await XD.wxBulk("metars")).slice(0,8)==="raw_text"` in server mode; in packs mode without `xperf-wx` meta it
  falls through to the local server (`proxy()` true) and still returns text.
- [ ] **Step 3:** syntax check `node -e "new Function(require('fs').readFileSync('data.js','utf8'))"`.
- [ ] **Step 4: Commit** `data.js index.html` — "XD: runway index and worldwide weather files".

### Task 4: Weather and sun — pure functions in `random.js`

**Files:**
- Create: `random.js` (pure section first; the UI is Task 6), `tests/random.test.mjs`
- Create: `tests/fixtures/awc-metars.csv.gz`, `tests/fixtures/awc-tafs.xml.gz` — copies of the live files taken once
  (`curl` from aviationweather.gov), kept small by filtering to ~300 METAR rows and ~100 TAFs that include snow,
  rain, fog and clear stations; the newest `observation_time` in the fixture is the test clock `T0`.

**Interfaces:**
- Produces (top-level functions in a classic script, loaded in tests with `vm` like `tests/routeimport.test.mjs`):
  - `parseMetarCsv(text: string) -> Obs[]`, `Obs = {id, lat, lon, t /*ms*/, raw, wx, vis /*SM|null*/,
    ceil /*ft|null*/, cat /*"VFR"|"MVFR"|"IFR"|"LIFR"|""*/}`. Header found by the line starting `raw_text`; the four
    repeated `sky_cover`/`cloud_base_ft_agl` pairs are read by column index; ceiling = lowest BKN/OVC/OVX base or
    `vert_vis_ft`; `vis` parses `10+` as 10.
  - `parseTafXml(text: string) -> Record<string, Taf>`, `Taf = {id, raw, from, to, fc: [{from, to, kind /*"FM"|
    "BECMG"|"TEMPO"|"PROB"|""*/, wx, vis, ceil}]}` — regex over `<TAF>…</TAF>` blocks (no DOMParser: tests run in
    `vm`); tags as in the live file (`station_id`, `fcst_time_from`, `change_indicator`, `visibility_statute_mi`
    `6+`, `wx_string`, `<sky_condition sky_cover cloud_base_ft_agl/>`).
  - `wxClass({wx, vis, ceil, cat}) -> {snow: bool, rain: bool, lowvis: bool}` — tokens split on spaces; ignore tokens
    starting `VC` or `RE`; snow = a token containing `SN` or `SG` or `PL` that is not `BLSN`/`DRSN`; rain = a token
    containing `RA` or `DZ` (incl. `FZRA`, `FZDZ`, `SHRA`, `TSRA`) and not snow; lowvis = cat IFR/LIFR, or vis < 3,
    or ceil < 1000.
  - `tafAt(taf: Taf, t: number) -> {wx, vis, ceil, cat}` — the prevailing (base/FM/BECMG) period at `t`, worsened by
    a TEMPO/PROB period covering `t`; `cat` derived from vis/ceil; `null` when `t` is outside the TAF.
  - `sunElevation(lat: number, lon: number, t: number) -> degrees` (NOAA simplified solar position; ±1° is enough).
  - `dayNight(elev: number) -> "day"|"night"|"twilight"` with the spec thresholds (> 0 day, < −6 night).

- [ ] **Step 1: Write the failing tests** (`tests/random.test.mjs`):
  - `parses the METAR fixture`: count equals the data rows; a known snow station row from the fixture has
    `wxClass(...).snow === true`; every row has numeric `lat/lon/t`.
  - `classifies weather groups`: `wxClass({wx:"VCSH BR",vis:5,ceil:3000,cat:"MVFR"})` → `{snow:false,rain:false,
    lowvis:false}`; `"-SHSN"` → snow; `"BLSN"` → not snow; `"-FZDZ"` → rain, not snow; `"RERA"` → not rain;
    `{wx:"",vis:0.25,ceil:200,cat:"LIFR"}` → lowvis.
  - `reads a TAF at a time`: from the CYHK sample (`TEMPO 2422/2504 3SM -SN BR BKN006`), `tafAt` at
    `2026-10-25T01:00Z` → snow true, vis 3, ceil 600; at `2026-10-25T05:00Z` the TEMPO `2SM -SN BR OVC004` applies;
    outside validity → `null`.
  - `sun elevation`: KSFO (37.62,-122.38) at `2026-06-21T20:00Z` > 70°; at `2026-06-21T08:00Z` < −6°;
    `dayNight(-3) === "twilight"`.
- [ ] **Step 2:** `node --test tests/random.test.mjs` → FAIL (functions missing).
- [ ] **Step 3: Implement** the functions in `random.js`.
- [ ] **Step 4:** `node --test tests/random.test.mjs` → PASS.
- [ ] **Step 5: Commit** `random.js tests/random.test.mjs tests/fixtures/awc-*` — "Random flight: weather parsing,
  weather classes and sun elevation".

### Task 5: Screening and generation — pure functions in `random.js`

**Files:**
- Modify: `random.js`, `tests/random.test.mjs`

**Interfaces:**
- Consumes: Task 4 functions.
- Produces:
  - `aircraftLimits(m) -> {kt, rangeNM, minRwyFt, paved}` (browser glue, uses globals `basePerf`, `FT`):
    `kt` = `m.cruiseMach*573` for OpenAP, else `m.P.cruiseTAS` (fallback 110); `rangeNM` = OpenAP
    `m.ac.cruise.range` km ÷ 1.852 × 0.9, else `m.P.cruiseRange − kt*0.75` (45-min reserve; fallback 300);
    `minRwyFt` = `max(to*sfTo, ldg*sfLdg)/FT` from `basePerf(m)`, fallback 2500 GA / 6000 airliner;
    `paved` = `m.kind==="openap"`.
  - `estMinutes(nm: number, kt: number) -> number` = `nm/kt*60 + 15`.
  - `generate(input) -> Option[]` where `input = {airports /*DB.airports: {icao,name,lat,lon,alt /*ft*/}[]*/, rwy /*XD.runwayIndex()*/,
    obs /*Obs[]*/, tafs /*Record<id,Taf>*/, lim /*aircraftLimits*/, prompts: {time, dep, arr, dist}, now /*ms*/,
    rand /*() => [0,1)*/}`; `prompts` values: time `day|night|any`, dep/arr `snow|rain|lowvis|any`, dist
    `short|long|any`. Returns up to **5** `Option = {dep, arr /*DB.airports entries*/, nm, min, light
    /*"day"|"night"|"twilight"*/, depWx /*Obs|null*/, arrWx /*{src:"metar"|"taf", raw, cat, wx, vis, ceil}|null*/,
    misses: string[] /*empty = full match*/}`, full matches first, then near misses by fewest misses.
  - Runway rule per airport: `rwy[id]` exists and (`paved` ? longestPavedFt : longestFt) ≥ `minRwyFt × (1 + 0.10 ×
    alt/1000)` (the takeoff pressure-altitude factor of `runwayPerf`, ISA, no wind). This replaces the
    spec's per-option `runwayPerf` confirmation (which would need an `airportInfo` fetch per airport); the planned
    flight still shows the full runway check.
  - Distance bands from `estMinutes`: short 20–120, long > 120 and `nm ≤ rangeNM`, any 20 and `nm ≤ rangeNM`.
  - Variety: no two options share a departure, and departures are ≥ 100 NM apart where enough candidates exist.
  - Near-miss notes (exact copy): `"rain instead of snow"` style `"<got> instead of <wanted>"` using the words
    `snow`, `rain`, `low visibility`, `no precipitation`; `"twilight, not dark yet"` / `"twilight, not full daylight"`;
    `"<h:mm> — just over short"` / `"<h:mm> — under long"`; `"no report at arrival"`.
  - `RandomFlight.now = () => Date.now()` (overridable; Task 6 uses it).

- [ ] **Step 1: Write the failing tests** with a hand-made world (8–10 airports, a runway index, synthetic `Obs` and
  one `Taf`, fixed `now`, seeded `rand`):
  - `returns 5 full matches when the world has them`, each with `misses.length === 0`.
  - `never pairs an airport with itself or a field within 5 NM`.
  - `respects the runway rule`: an A320-like `lim` ({paved:true,minRwyFt:6500}) never gets an airport whose only
    paved runway is 5000 ft, nor a 9000 ft gravel strip; a high-elevation 7000 ft airport (elev 5500) is rejected.
  - `distance bands`: with `kt` 120, short never exceeds 120 min, long never exceeds `rangeNM`.
  - `night needs real darkness`: a departure at sun −3° is only a near miss with note `"twilight, not dark yet"`.
  - `uses the TAF beyond 90 minutes`: an option with `min > 90` has `arrWx.src === "taf"`.
  - `stale reports are ignored`: an Obs with `t = now − 2 h` never becomes a departure for a weather prompt.
  - `fills with near misses, labelled`: prompts dep `snow` in a world with only rain → 5 options, each `misses`
    includes `"rain instead of snow"`.
  - `falls back when the aircraft lacks data`: `aircraftLimits` on a stub model without `cruiseRange`/
    `takeOffDistance` (stub `basePerf` returning `{}`) gives `rangeNM 300 − …`, `minRwyFt 2500`.
- [ ] **Step 2:** `node --test tests/random.test.mjs` → new tests FAIL.
- [ ] **Step 3: Implement.** Approach: index airports by ident; departures = fresh Obs (≤ 90 min) whose ident is in
  `airports` and passes runway + dep weather + time (or every runway-qualifying airport when dep and time are both
  `any`, sampled with `rand`); for each sampled departure, arrivals within the band by great-circle distance (use a
  1° lat/lon grid bucket to avoid an all-pairs scan), filtered by runway and arrival weather; score misses per prompt;
  pick with `rand` under the variety rule. Must finish < 1 s on the full fixture (~5k Obs, 49k airports).
- [ ] **Step 4:** `node --test tests/random.test.mjs` → PASS; also `node --test tests/*.test.mjs` all PASS.
- [ ] **Step 5: Commit** `random.js tests/random.test.mjs` — "Random flight: screening, distance bands and near
  misses".

### Task 6: The panel, entry points and picking an option

**Files:**
- Modify: `index.html` (hero button, panel markup in `#startcol`/next to `.formcol`, `<script src="random.js?v=…">`
  after `chips.js`, `?v=` bumps), `chips.js` (export a planner), `shell.js` (palette command), `styles/app.css`
  (panel and option cards), `tools/ui_check.mjs` (new check)

**Interfaces:**
- Consumes: Tasks 3–5; `AcPicker.set(id)`, `MODEL_P`, `Chips.replan`, `Chips.syncForm`.
- Produces:
  - `Chips.planFlight(ac: string, dep: string, arr: string, nav: string, etdUtc?: string /*"YYYY-MM-DDTHH:MM"*/)` —
    `runExample`'s body generalised (sets `#etd` when given); `runExample` calls it.
  - `RandomFlight.open()`, `RandomFlight.close()` — show/hide the panel in place of the setup form (`.formcol`);
    the hero gets a `<button class="heroex herorandom" data-random>` "Random flight · live weather"; palette command
    `{group:"Flight", label:"Random flight", run:()=>RandomFlight.open()}`.
  - Panel prompts as `.seg` groups (GA/Airliner, time, dep weather, arr weather, distance), aircraft `<select>`
    filtered to the group (default: the remembered `xperf.ac` if it is in the group, else C172 / A320), buttons
    **Generate flights** and **Fully random** (keeps the aircraft, all prompts `any`, does not overwrite the saved
    prompts). Answers saved to `localStorage xperf.random` (try/catch).
  - Option card: `ICAO → ICAO`, names, `nm` NM, `h:mm`, day/night/twilight, departure and arrival tags coloured by
    flight category with the short weather (`FG ¼ SM OVC002` style), `forecast` label when `arrWx.src==="taf"`,
    `misses` joined as a note, `title` = raw METAR/TAF. Click → `close()` then `Chips.planFlight(acId, dep, arr,
    $("nav").value||"direct", etd)` with ETD = `RandomFlight.now()` rounded up to the next 10 min.
  - `XD.wxBulk`/`XD.runwayIndex` are first called by `open()`, never at app start (spec: no slower startup).
  - States: "Loading live weather from aviationweather.gov…", error text from `XD.wxBulk` + Retry, "Nothing close
    enough right now — try Any for one of the prompts." when `generate` returns 0.

- [ ] **Step 1: Write the failing UI check** `random-flight` in `tools/ui_check.mjs` (server mode and packs mode):
  open the app, before any data request override in-page `XD.wxBulk` to resolve the two fixture files' text and
  `RandomFlight.now = () => T0`; click `[data-random]`; select Airliner + `oap:a320`, prompts any/any/any/short;
  click Generate → exactly 5 `.rfopt` cards; click the first → the Overview renders and `#dep`/`#arr` equal the
  card's idents; then reopen, make `XD.wxBulk` reject → the error text and a Retry button appear, no spinner left.
  Also at phone width (375 px) the panel has no horizontal scroll.
- [ ] **Step 2:** `node tools/ui_check.mjs --mode server --only random-flight` → FAIL.
- [ ] **Step 3: Implement** the panel, `Chips.planFlight`, the palette command, styles; bump `?v=` on every changed
  file. Syntax-check each JS file with `node -e "new Function(...)"`.
- [ ] **Step 4:** `--only random-flight` PASS in `--mode server` and `--mode packs`; then a full
  `node tools/ui_check.mjs --mode packs` run all PASS (one run at a time); `node --test tests/*.test.mjs` PASS;
  regress 6/6 identical.
- [ ] **Step 5: Verify by eye** in the browser pane with live data: GA C172, night, low vis, any, short — screenshot the
  panel with results in dark and light; show it to the owner.
- [ ] **Step 6: Commit** — "Random flight panel on the start screen".

### Task 7: Ship — relay, site, handoff

**Files:**
- Modify: `HANDOFF.md` (feature, endpoints `/api/rwyindex` `/api/wxbulk`, `rwyidx.json`, relay routes,
  `xperf.random` key), `tools/wx-worker.js` deploy only (no code change)

- [ ] **Step 1: Deploy the relay** from an isolated temp folder containing only `wx-worker.js` and a `wrangler.toml`
  (`name = "xperf-wx"`, `main = "wx-worker.js"`, `compatibility_date = "2026-10-01"`, `preview_urls = false`,
  `[vars] ALLOW_ORIGIN = "https://xperf.n1ghtflight.workers.dev"`). Check the output lists no assets. Verify:
  `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://xperf-wx.n1ghtflight.workers.dev/data/cache/metars.cache.csv.gz`
  → `200 application/gzip`; `/data/cache/pireps.cache.csv.gz` → 404.
- [ ] **Step 2: Deploy the site** with `python tools/airac_update.py --force`; check it reports the live cycle.
- [ ] **Step 3: Verify live** in the browser pane on https://xperf.n1ghtflight.workers.dev: Random flight → Generate
  with real weather returns options; pick one → planned.
- [ ] **Step 4: Update `HANDOFF.md`** and commit; push `main` only when the owner says so.
