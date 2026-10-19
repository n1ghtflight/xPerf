# Takeoff Performance View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new **Takeoff** view that estimates V1/VR/V2, reduced-thrust temperature, flaps and required vs available runway for every OpenAP airliner, pre-filled from the plan, with A20N and B738 tuned to manufacturer airport-planning charts.

**Architecture:** A pure model file `toperf.js` (global `var TOPerf`, no DOM) does all the physics and is unit-tested in `node:vm` like `blueprint.js`. Two sourced data files (`data/to_ref.json`, `data/to_tune.json`) load through the `XD` adapter. A view file `takeoff.js` turns the plan `X` into model inputs, renders the view and the two summaries (Overview tile, FS2024 setup §3 row), and holds overrides and options.

**Tech Stack:** Vanilla browser JS (no build step), Python stdlib server, `node --test`, Edge over CDP for UI checks (`tools/ui_check.mjs`, `tools/shoot.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-18-takeoff-performance-design.md`. Read it first. This plan does not repeat its model description (sections "Model" 1–11).

## Global Constraints

- Every result carries the badge "XPerf estimate · for simulation only". Tuned types say "tuned to Airbus/Boeing airport-planning charts".
- No change to any existing plan or Airports-view number: `basePerf()`/`runwayPerf()` stay as they are. `node tools/regress.mjs compare` (server on 8770) may differ **only** in `inventory` (new ids and `data-*` hooks).
- All data access goes through `XD` in `data.js`. Never `fetch()` a path directly.
- Bump `?v=` on every script tag whose file changes; new scripts get one too.
- Preserve CRLF in `index.html`, `nav.js`, `overview.js`, `shell.js`, `palette.js` (and any other file that has it; check with `file <name>`). New files: CRLF, to match.
- No code or data copied from perfcalc.pradz.de, FlyByWire (GPL-3) or any aircraft EFB. Manufacturer charts are read and cited per value, never embedded.
- **Before downloading any file** (the FAA database, the Airbus/Boeing PDFs), ask the user in chat and state the filename, source URL and size. Avoid Firecrawl for PDFs (the owner's monthly credits are limited); use WebFetch or ask.
- Commit author comes from the local git config (`n1ghtflight`). End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Units: weight kg; distances ft first, m second; speeds kt; temperatures °C.
- Out of scope (spec Non-goals): landing, trim/THS, contaminated runways, obstacles, VMCG/VMBE/tyre limits, GA-table aircraft.

## Review Focus

1. **No METAR** (packs mode with no relay, or a field without reporting): the view still computes with ISA, calm and Dry, each marked "assumed — no METAR". Pinned in Task 5 (`toInputs` test).
2. **Variable wind and tailwind**: `VRB` uses zero headwind, and a tailwind adds 150 %. A tailwind can turn "fits" into "does not fit" without NaN. Pinned in Task 2 (wind test) and Task 5.
3. **Intersection longer than the runway, or a typed negative or empty value**: available length is clamped to ≥ 0, giving "Does not fit" with the shortfall, no NaN. Typed values are parsed as numbers and ignored when invalid. Pinned in Task 3.
4. **A GA aircraft, or an airliner with an estimated engine** (`m.eng.estimated`): GA shows the pointer note instead of numbers. An estimated engine adds a note to `notes`. Pinned in Task 5 and Task 3.
5. **Above MTOW, or a weight so heavy that even TOGA doesn't fit**: results still render, with a warning line and the red "Does not fit" state showing the shortfall in ft. Pinned in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `toperf.js` (new) | Pure model: atmosphere, thrust, speeds, balanced field, reduced-thrust search, flaps sweep, tuning factor. Global `var TOPerf`. |
| `takeoff.js` (new) | Plan → inputs (`toInputs`), view render, Overview tile and setup-row HTML, overrides/options state, event wiring. |
| `data/to_ref.json` (new) | Per OpenAP type: VREF at MLW + source, flap detents → level, family, reduced-thrust label. |
| `data/to_tune.json` (new) | A20N/B738 chart points (cited) + fitted factors. |
| `tools/to_fixture.mjs` (new) | One-off: builds `tests/fixtures/to_aircraft.json` (acData for all 37 types) from OpenAP raw files. |
| `tools/fit_to_tune.mjs` (new) | Fits the tuning factors into `data/to_tune.json` and prints residuals. |
| `tests/toperf.test.mjs` (new) | Model, data-file and `toInputs` tests. |
| `data.js` | `XD.toRef()`, `XD.toTune()` |
| `index.html` | Script tags; sidebar link; phone More-sheet button; `<div class="tabpanel" data-tab="takeoff">` in `render()`; data load in `init()` |
| `shell.js` | `VIEWS`, `CHORDS` (`t`) |
| `palette.js` | "Go to Takeoff" with `G T` |
| `overview.js` | Takeoff tile |
| `nav.js` | §3 Cockpit row; runway select shared with `DEPRWY_KEY` |
| `styles/app.css` | View styles (tokens only) |
| `tools/build_site.py` | Copy and precache the two data files |
| `tools/ui_check.mjs` | View lists and chords include `takeoff` |

---

### Task 1: Reference data `data/to_ref.json` + XD loader

**Files:**
- Create: `data/to_ref.json`, `tests/toperf.test.mjs`
- Modify: `data.js:143` (next to `gaPerf`), `tools/build_site.py:56,77`

**Interfaces:**
- Produces: `data/to_ref.json` shaped as
  `{"_schema":{…}, "types":{"a20n":{"vrefMLW":{"v":136,"s":"pub","src":"FAA ACD","ref":"…"},"family":"airbus","label":"FLEX","flaps":[{"name":"1+F","level":"low"},{"name":"2","level":"mid"},{"name":"3","level":"high"}]}, …}}`.
  Keys are the lowercase OpenAP codes of `AC_NAMES` (all 37). `s` ∈ `pub|est`. `level` ∈ `low|mid|high`. `label` ∈ `FLEX|Assumed temp|TO temp`.
- Produces: `XD.toRef(): Promise<object>` and `XD.toTune(): Promise<object>` (same `once(…, get(path,"json",60000))` pattern as `gaPerf`).

- [ ] **Step 1: Write the failing test** `"to_ref covers every OpenAP type with sane values"` in `tests/toperf.test.mjs`. Read `AC_NAMES` from `index.html` with the same regex as `tests/blueprint.test.mjs`. Assert, for every code: an entry exists; `100 <= vrefMLW.v <= 175`; `vrefMLW.s` is `pub` or `est` and `src` is non-empty; `flaps` has 1–5 entries, each `level` in `low|mid|high`, with levels non-decreasing in array order; `label` is one of the three allowed values.
- [ ] **Step 2: Run** `node --test tests/toperf.test.mjs`. Expected: FAIL (file missing).
- [ ] **Step 3: Build the data.** Ask the user before downloading the FAA Aircraft Characteristics Database (faa.gov/airports/engineering/aircraft_char_database). Take "approach speed" (VREF at max landing weight) per type and record the row used in `ref`. Types it lacks: `v` = WRAP `ld_v_app` (m/s → kt) + 5, with `s:"est"` and `src:"WRAP ld_v_app + 5 kt"`. Flap detents per family come from public sources; record each source in `_schema`. Families: Airbus `1+F/2/3`; 737 `1/5/10/15/25`; 757 `1/5/15/20`; 767/777/787 `5/15/20`; 747 `10/20`; E-Jets `1/2/3/4`; CRJ900, ERJ145, C550, G650 per their public docs. Labels: Airbus `FLEX`; Boeing `Assumed temp`; others `TO temp`. Write the file with CRLF line endings.
- [ ] **Step 4: Add `XD.toRef` / `XD.toTune`** in `data.js`. Add both files to `copy(...)` and to the `shell` precache list in `tools/build_site.py`. Create `data/to_tune.json` as `{"_schema":{},"types":{}}` for now.
- [ ] **Step 5: Run** `node --test tests/toperf.test.mjs`. Expected: PASS.
- [ ] **Step 6: Commit** `data/to_ref.json data/to_tune.json data.js tools/build_site.py tests/toperf.test.mjs` with the message "Takeoff reference data: VREF at MLW, flap detents, labels per type".

### Task 2: Core field-length model in `toperf.js`

**Files:**
- Create: `toperf.js`, `tools/to_fixture.mjs`, `tests/fixtures/to_aircraft.json`
- Test: `tests/toperf.test.mjs`

**Interfaces:**
- Produces `acData` (plain object, the only aircraft shape the model sees):
  `{code, nEng, S, cd0, k, gearCd0, mtow, mlw, span, length, thrust0 /*N per engine*/, bpr, engEstimated, vrefMLW /*kt*/, vrefSrc, family, label, flaps:[{name,level}], tune:{factor, altK}|null}`
- Produces `TOPerf.acFromModel(m, ref, tune) → acData`, where `m` is XPerf's OpenAP model (`m.ac`, `m.eng`, `m.nEng`, `m.polar`), `ref = toRef.types[m.code]` and `tune = toTune.types[m.code] || null`. Gear comes from `m.ac.drag.gears` (default 0.017), length from `m.ac.fuselage.length`.
- Produces `TOPerf.fieldLength(ac, env, level, assumedT) → {v1, vr, v2, vs /*kt*/, requiredM, goM, stopM, aeo115M, v1DistM, grad2}`.
  `env = {massKg, paFt, oat, hwKt /*+head, already 50%/150%-factored*/, slopePct /*+uphill*/, wet, bleed /*thrust multiplier*/}`.
- `toperf.js` must declare `var TOPerf = (()=>{ … return {…}; })();` so `vm.runInContext` exposes it. `const` does not appear on the context.
- `tools/to_fixture.mjs` writes `acData` for all 37 types (OpenAP raw YAML and engines.csv from the same mirror `index.html` uses, plus `data/to_ref.json`), so tests run offline. Run it once and commit its output.

Starting constants (spec leaves them to the builder; begin here, give each a one-line reason in the code):

| level | CLmax fraction of landing | flap Δcd0 | ground-roll CL |
|---|---|---|---|
| low | 0.78 | 0.012 | 0.55 |
| mid | 0.83 | 0.020 | 0.65 |
| high | 0.88 | 0.030 | 0.75 |

Also: VREF = 1.23 VSR(landing); V2 = 1.13 VSR; VR = max(V2 − 6 kt, 1.05 VSR); VLOF = (VR+V2)/2. μ rolling 0.02 dry / 0.025 wet. μ braking 0.40 dry / 0.20 wet, plus 0.03 reverser credit on wet only. Stop allowance: 2 s at V1. Rotation and transition time: 3 s at VLOF. Screen height 35 ft, or 15 ft for one engine out on wet. Bartel & Young speed lapse as in `climbThrust` (`index.html:384`). Pressure-ratio lapse `δ^0.8`. Flat rated to ISA+15, then −0.8 %/°C. V1 floor 0.9·VR. Balance V1 by bisection on (go − stop), not a sweep. The throwaway spike (`tospike.mjs`, in the original session's scratchpad) gave A320 70 t SL ISA "low": V1 135 / VR 142 / V2 148, about 1,760 m with V2 = 1.13 VSR. Expect numbers in that region.

- [ ] **Step 1: Write failing tests** with `ac = fixture.a20n` (and `b738`), `env0 = {massKg:70000, paFt:0, oat:15, hwKt:0, slopePct:0, wet:false, bleed:1}`, `level:"low"`, `assumedT = oat`:
  - `"speeds ordered"`: `vs < v1 <= vr < v2`, all finite.
  - `"heavier, hotter, higher, uphill are longer"`: `requiredM` increases for massKg 76000, oat 35 (assumedT 35), paFt 5000, slopePct +1.
  - `"headwind shorter, tailwind longer"`: hwKt +10 gives less, hwKt −10 gives more, both finite.
  - `"wet lowers V1"`: `wet:true` gives a lower `v1`.
  - `"higher assumed temperature needs more runway"`: assumedT 50 gives more than assumedT 15 (same oat).
  - `"every type computes at MTOW"`: for each fixture type, `fieldLength(ac,{...env0,massKg:ac.mtow},"mid",15)` has all fields finite and `requiredM` between 800 and 4500.
- [ ] **Step 2: Run** `node --test tests/toperf.test.mjs`. Expected: the new tests FAIL (`TOPerf` undefined).
- [ ] **Step 3: Write `tools/to_fixture.mjs`, run it, commit its output; implement `acFromModel` and `fieldLength`** per spec Model 1–6 and 8, with the constants above.
- [ ] **Step 4: Run** `node --test tests/toperf.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `toperf.js tools/to_fixture.mjs tests/fixtures/to_aircraft.json tests/toperf.test.mjs` with the message "Takeoff model: balanced field length, V-speeds, one-engine-out gradient".

### Task 3: Reduced-thrust search, flap sweep, `TOPerf.compute`

**Files:**
- Modify: `toperf.js`
- Test: `tests/toperf.test.mjs`

**Interfaces:**
- Consumes: `fieldLength`, `acData` (Task 2).
- Produces `TOPerf.compute(ac, input) → result`, where
  `input = {towKg, elevFt, qnh, oat, windKt /*signed headwind component, raw*/, slopePct, lengthFt, intersectionFt, lineup:"none"|"90"|"180", wet, packs, antiIce:"off"|"eng"|"wing", thrust:"reduced"|"full", flap:"optimum"|<detent name>}`
  and
  `result = {byFlap:[{flap, level, v1, vr, v2, assumedT /*°C or null*/, thrustRed /*0..0.25*/, requiredFt, availableFt, goFt, stopFt, v1Ft, grad2, grad2Min, fits, limits:[{id:"field"|"grad2"|"thrust", ok, text}]}], optimum /*flap name or null*/, selected /*the byFlap entry shown*/, status:"reduced"|"toga"|"nofit", shortfallFt, notes:[string]}`.
- Rules pinned by the spec: headwind counts 50 %, tailwind 150 %; `grad2Min` = 0.024 / 0.027 / 0.030 for 2 / 3 / 4 engines; thrust ≥ 75 % of full; assumed temperature ≥ OAT, ≥ the flat-rating temperature, ≤ ISA+55. `availableFt = max(0, lengthFt − intersectionFt − lineup)`, with the line-up allowance 0 / `ac.length` / `ac.span` (m→ft) for none/90/180. Optimum = highest assumedT, ties to the lower flap. Bleed multipliers (builder's constants, start here): packs on 0.985, engine anti-ice 0.98, engine+wing 0.96. Tuning: `requiredM × tune.factor × (1 + tune.altK·paFt/1000)` when `ac.tune`. Notes: `engEstimated` → "Engine thrust estimated — results less certain"; `vrefSrc` est → "Approach speed estimated from ADS-B data"; `towKg > mtow` → "Takeoff weight above MTOW".
- Temperature search by bisection between the lower bound and ISA+55 (feasibility is monotonic in temperature).

- [ ] **Step 1: Write failing tests** with fixture `a20n`, `inp0 = {towKg:70000, elevFt:13, qnh:1013, oat:18, windKt:0, slopePct:0, lengthFt:11870, intersectionFt:0, lineup:"none", wet:false, packs:true, antiIce:"off", thrust:"reduced", flap:"optimum"}`:
  - `"reduced thrust on a long runway"`: `status==="reduced"`, `selected.assumedT >= 18`, `selected.thrustRed <= 0.25`, `optimum` is one of the type's detents, `byFlap.length === ac.flaps.length`.
  - `"short runway gives TOGA only"`: choose `lengthFt` = the full-thrust `requiredFt` × 1.02 → `status==="toga"`, `assumedT===null`.
  - `"too short does not fit"`: `lengthFt:4000` → `status==="nofit"`, `shortfallFt > 0`, all numbers finite.
  - `"intersection beyond the runway clamps"`: `intersectionFt:20000` → `availableFt===0`, `status==="nofit"`. `intersectionFt:-50` is treated as 0.
  - `"tailwind uses 150 %"`: `windKt:-10` needs more than `windKt:+10` and more than 0. `windKt:0` equals the result for zero wind.
  - `"anti-ice and packs lower the temperature"`: `antiIce:"wing"` assumedT < `"off"`; `packs:false` assumedT ≥ `packs:true`.
  - `"wet never raises the temperature"`: `wet:true` assumedT ≤ dry.
  - `"above MTOW still computes with a note"`: `towKg: ac.mtow + 2000` → finite results, `notes` includes "Takeoff weight above MTOW".
  - `"fast enough"`: 20 runs of `compute` for `b77w` finish in under 2,000 ms total (target: under 100 ms each).
- [ ] **Step 2: Run.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement `TOPerf.compute`** per spec Model 7, 9 and 10 and the rules above.
- [ ] **Step 4: Run.** Expected: PASS (all earlier tests too).
- [ ] **Step 5: Commit** with the message "Takeoff model: reduced-thrust temperature, flap sweep, limits".

### Task 4: Tuning for A20N and B738

**Files:**
- Create: `tools/fit_to_tune.mjs`
- Modify: `data/to_tune.json`, `toperf.js` (add `TOPerf.tuningReport`)
- Test: `tests/toperf.test.mjs`

**Interfaces:**
- `data/to_tune.json` → `types.a20n|b738 = {factor, altK, points:[{massKg, paFt, oat, flap, lengthFt, doc, rev, page, chart}], residualMaxPct}`.
- Produces `TOPerf.tuningReport(ac, points) → [{point, modelFt, chartFt, errPct}]`. It uses `compute` at full thrust, dry, no wind or slope, with `flap` set to the point's detent and `requiredFt` from that row.
- `tools/fit_to_tune.mjs`: fit `factor = exp(mean(ln(chart/model)))` with `altK = 0`. If any residual is above 5 %, fit `altK` by least squares too. Write both and `residualMaxPct` back. Print the report.

- [ ] **Step 1: Write the failing test** `"tuned types match the charts within 5 %"`: for each type in `to_tune.types`, every `|errPct| <= 5`, and `points.length >= 3`. Also `"untuned types have no factor"`: `acFromModel` for a type not in the file has `tune === null`.
- [ ] **Step 2: Run.** Expected: FAIL (no points yet).
- [ ] **Step 3: Get the charts.** Ask the user before downloading: Airbus "A320 Aircraft Characteristics – Airport and Maintenance Planning" (A320neo, the PW1100G takeoff-weight-limitation chart) and Boeing "737 Airplane Characteristics for Airport Planning" (737-800, CFM56-7B26, FAR takeoff runway length). Read off at least 3 points per type, spread over weight and, if charted, altitude/temperature. Cite every point. If a chart isn't freely available for the exact variant, leave that type out of the file and say why in `_schema.untuned`; the test then covers only the types that are present (spec call 11).
- [ ] **Step 4: Run** `node tools/fit_to_tune.mjs`, then `node --test tests/toperf.test.mjs`. Expected: PASS, with the residual table printed. Also print the spec's spot check (not a gate): A20N 70 t, sea level ISA, long runway, at each flap → V1/VR/V2, kept with the report for the user.
- [ ] **Step 5: Commit** `data/to_tune.json tools/fit_to_tune.mjs toperf.js tests/toperf.test.mjs` with the message "Tune A20N/B738 takeoff field length to airport-planning charts".

### Task 5: Plan → inputs, the Takeoff view, navigation

**Files:**
- Create: `takeoff.js`
- Modify: `index.html` (script tags after `toperf.js`; sidebar link after Airports `index.html:59`; More-sheet button `index.html:175`; tabpanel in `render()` `index.html:1047`; load `XD.toRef()`/`XD.toTune()` in `init()` alongside the OpenAP files), `shell.js:11-14`, `palette.js:144`, `nav.js:819-830`, `styles/app.css`, `tools/ui_check.mjs:62,68,336`
- Test: `tests/toperf.test.mjs`

**Interfaces:**
- Consumes: `TOPerf.compute`, `TOPerf.acFromModel`, `chosenDepRunway(D)` and `DEPRWY_KEY` (nav.js), `X.briefs.dep` (`met`, `ends`, `a`), `X.sel.tow`, `X.m`.
- Produces (in `takeoff.js`, as `function` declarations so the vm test can reach them):
  - `toInputs(X, end, overrides, opts) → {input, src}`. `src` maps each field to `"OpenAP"|"plan"|"setup"|"METAR hhmmZ"|"runway ends"|"assumed — no METAR"|"edited"`. Slope = (other end elev − this end elev)/length·100. `windKt` = steady-wind headwind component `wspd·cos(wdir − end.hdgT)` (METAR winds are true, as is `hdgT`); 0 when VRB or calm; gusts ignored (spec call 7). `toInputs` uses no DOM and no globals; `takeoffResult` checks for GA before touching nav.js helpers.
  - `takeoffResult(X) → {ac, input, src, result} | {ga:true} | null`. Uses the chosen runway and the remembered options; called once in `render()` and stored as `X.takeoff`.
  - `takeoffView(X) → html`, `takeoffTile(X) → html`, `takeoffSetupRow(X) → html`.
- State: options in localStorage `xperf.to.opts` (`{flap, thrust, packs, antiIce, wet?}`; `wet` only when the user set it). Overrides and intersection are in-memory, keyed to the plan, and cleared when `render()` gets a new `X` (spec call 5). Changing the runway in the view writes `DEPRWY_KEY+icao` (spec call 6), then re-renders. `Shell.VIEWS` gains `["takeoff","Takeoff"]` after `airports`; `CHORDS.t="takeoff"`; the palette gets `["takeoff","T"]`.

- [ ] **Step 1: Write failing tests** (vm-load `toperf.js` and `takeoff.js`; a minimal hand-built `X` and `end`, no DOM):
  - `"METAR values flow through with sources"`: with `met={temp:18,qnh:1016,wdir:290,wspd:14,wet:false,time:"1756Z"}` and runway heading 284°T → `input.oat===18`, `input.qnh===1016`, `input.windKt` ≈ 13.9 (±0.5), `src.oat==="METAR 1756Z"`.
  - `"no METAR assumes ISA and calm"`: `met=null`, elevation 1000 ft → `input.oat===13` (15 − 2/1000 ft, rounded), `input.qnh===1013.25`, `windKt===0`, `wet===false`, and each of those `src` values is `"assumed — no METAR"`.
  - `"VRB wind is zero headwind"`: `met.vrb=true` → `windKt===0`.
  - `"overrides win and are marked"`: `overrides={oat:30}` → `input.oat===30`, `src.oat==="edited"`.
  - `"GA aircraft gets the pointer"`: `X.m.kind==="apm"` → `takeoffResult(X)` returns `{ga:true}`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `takeoff.js`** to the spec "UI" section and the mockup (`takeoff-landing-mockup.html` in the session notes folder `C:\Users\Announ\AppData\Roaming\Claude\side-session-notes\local_7bb711ee-5ef2-4728-a5f3-2c66b2f78fde`). Header badge; inputs column with source tags and "edited · reset"; segmented controls (`.seg`) for flaps (Optimum + detents), thrust (label from `ac.label` / "TOGA"), packs, anti-ice, Dry/Wet; numeric fields for intersection and a line-up select. Results: big numbers (the reduced-thrust temperature in `--accent`, everything else neutral); an SVG runway bar drawn with tokens (available, hatched intersection/line-up, go and stop bars, V1 tick, margin); a limits list with "Obstacles, VMCG / VMBE / tyre speed — not modelled" in `--warn`; the flap table with the optimum row on `--selected`; an accuracy callout; and the one-line note "The Airports view uses a simpler runway check" (spec call 10). States: `nofit` shows "Does not fit — short by N ft" in `--bad`; `toga` shows "TOGA only". GA shows "Takeoff data is for airliners. For this aircraft see the runway check in Airports & weather." Recompute on input/change events without re-planning; refresh the Overview tile and setup row in place.
- [ ] **Step 4: Wire navigation** (VIEWS, CHORDS, sidebar `data-kbd="G T"`, More sheet, palette, `ui_check.mjs` lists). Bump `?v=` on `shell.js`, `palette.js`, `nav.js`, `data.js`.
- [ ] **Step 5: Run** `node --test tests/toperf.test.mjs tests/palette.test.mjs tests/routeimport.test.mjs tests/blueprint.test.mjs tests/wx-worker.test.mjs` and the syntax checks (`node -e "new Function(require('fs').readFileSync('<file>','utf8'))"` for every changed JS file). Expected: all PASS.
- [ ] **Step 6: Look at it.** Start `python -u server.py 8770` in the background. Plan A20N KSFO→KLAX and B738 KJFK→KBOS; open the Takeoff view; take screenshots with `$env:XPORT=8770; node tools\shoot.mjs <outDir> 1440 oap:a20n KSFO KLAX direct` and at width 390; check both themes. Expected: chrome darker than the surface, exactly one accent value, no horizontal overflow, numbers aligned.
- [ ] **Step 7: Commit** with the message "Takeoff view: inputs from the plan, V-speeds, reduced-thrust temperature, runway bar".

### Task 6: Overview tile and FS2024 setup row

**Files:**
- Modify: `overview.js` (a tile next to the fuel tile; adjust `span-*` so every row still totals 12), `nav.js:655-665` (one `box(...)` in §3 Cockpit), `index.html` (`?v=` bumps)

**Interfaces:**
- Consumes: `takeoffTile(X)`, `takeoffSetupRow(X)`, `X.takeoff` (Task 5).
- Tile: title "Takeoff · <rwy>", tr "estimate"; value "<label> <T> °C", or "TOGA", or "Does not fit" (`--bad`); sub "<flap> · V1 · VR · V2"; `data-open="takeoff"`. Setup box: key "Takeoff data", value "V1 / VR / V2", sub "<label> <T>° · flaps <flap>". Both are omitted for GA aircraft.

- [ ] **Step 1: Implement both**, reusing `tile()`/`head()` (overview.js) and `box()` (nav.js) as they are.
- [ ] **Step 2: Verify** with the A20N plan from Task 5: the Overview tile shows the same numbers as the view and opens it on click/Enter; the setup row matches; a C172 plan shows neither. Screenshot the Overview at 1440 and 390.
- [ ] **Step 3: Commit** with the message "Takeoff summary on Overview and in FS2024 setup".

### Task 7: Whole-app verification and static build

**Files:**
- Modify: `tools/regress/baseline/*.json` (only via `--accept`, and only if the diff is inventory-only)

- [ ] **Step 1: Regression.** With the server on 8770: `node tools/regress.mjs compare`. Expected: either no differences, or differences only under `inventory`. If anything else differs, stop and fix the cause. If inventory-only: `node tools/regress.mjs compare --accept` and commit the baselines, saying in the message that only the hooks changed. If replay fails because `data/to_ref.json` / `data/to_tune.json` were not recorded, check how `tools/cdp.mjs` replays same-origin static files before changing anything.
- [ ] **Step 2: UI checks.** Run `node tools/ui_check.mjs --mode server`, then (never at the same time) `--mode packs`. Each takes about 10 min, so run them in the background. Expected: all checks pass, including views, chords and overflow with `takeoff`.
- [ ] **Step 3: Static site.** `python build_packs.py` (if no current pack), then `python tools/build_site.py`. Expected: `dist/site/data/to_ref.json` and `to_tune.json` exist and both appear in `dist/site/sw.js` PRECACHE. Serve `dist/site` with `python -m http.server 8771` and open `http://localhost:8771/`: the Takeoff view works with "assumed — no METAR" when no relay is set.
- [ ] **Step 4: Final commit** of anything outstanding. Report the tuning residual table and the screenshots to the user.
