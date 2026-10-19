# Landing Performance (Takeoff & landing view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the landing side to the Takeoff view: VREF/VAPP with wind additive, suggested autobrake, actual and factored landing distance against LDA, for every OpenAP airliner, with A20N/B738 tuned to the airport-planning landing charts.

**Architecture:** Same split as takeoff. A pure model `TOPerf.computeLanding` in `toperf.js`, landing data in `data/to_ref.json` (built by `tools/build_to_ref.py`) and `data/to_tune.json` (`landing` block per tuned type), and the view in `takeoff.js` behind a Departure / Arrival switch.

**Tech Stack:** Vanilla browser JS, Python stdlib, `node --test`, Edge over CDP (`tools/ui_check.mjs`, `tools/regress.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-18-takeoff-performance-design.md`, "Addendum A — Landing". Also the takeoff plan `docs/superpowers/plans/2026-10-18-takeoff-performance.md`, whose conventions this plan reuses.

## Global Constraints

- Label every result "XPerf estimate · for simulation only"; tuned types also say "tuned to … airport-planning charts".
- No change to plan numbers, the Airports runway check, or the existing FS2024 setup §5 "Landing distance" line. `node tools/regress.mjs compare` must stay 6/6 identical (run on a free port with a port-rewritten local copy of the fixtures, as in takeoff Task 7).
- Data only through `XD`; `?v=` bumps; CRLF kept; no code or data copied from EFBs, FlyByWire or pradz. Chart points are cited per value.
- Don't touch the map/route code or the title-bar chip: the main session is editing those.
- Don't push or deploy.
- Units: kg, ft first / m second, kt, °C. Speeds are EAS/CAS, the ground run uses TAS.
- Robustness is the same as takeoff: no NaN for any input; out-of-range typed values are ignored; infinite distances show "—".

## Review Focus

1. **No METAR at the arrival field:** ISA, calm and Dry, marked "assumed — no METAR". Pinned in L4 (`toLandingInputs` test).
2. **Gusts and tailwind:** the gust increment is included in VAPP (Boeing style) and capped; a tailwind adds nothing to VAPP but lengthens the distance (×150 %). Pinned in L2.
3. **Displaced threshold larger than the runway, or a typed LDA ≤ 0:** LDA clamps to ≥ 0 and the result is "Does not fit", no NaN. Pinned in L2.
4. **Above MLW:** results render, with the note "Landing weight above MLW". Pinned in L2.
5. **Arrival runway from an approach whose runway isn't in the runway list:** falls back to the best runway. Pinned in L4 (`landingResult` uses `B.best`).

---

## File Structure

| File | Change |
|---|---|
| `tools/build_to_ref.py` / `data/to_ref.json` | Per type: `landingFlaps:[{name,frac,default}]`, `autobrake:[{name,decel}]` (decel m/s², `null` = max manual braking), `vapp:"airbus"\|"boeing"` |
| `toperf.js` | `landingVSpeeds`, `landingRoll`, `computeLanding`, `landingTuningReport`; `acFromModel` carries the landing fields and `tuneLdg` |
| `data/to_tune.json` + `tools/fit_to_tune.mjs` | `types.<code>.landing = {factor, altK, residualMaxPct, points}`; the fitter handles both blocks |
| `takeoff.js` | Departure / Arrival switch, `toLandingInputs`, `landingResult`, landing view, `landingSetupRow`, two-half tile |
| `index.html`, `shell.js`, `nav.js` (§5 box only), `styles/app.css`, `tools/ui_check.mjs` | Wiring; the view label becomes "Takeoff & landing" |
| `tests/toperf.test.mjs` | Landing tests |

---

### Task L1: Landing reference data

**Files:** `tools/build_to_ref.py`, `data/to_ref.json`, `tests/toperf.test.mjs`

**Interfaces — produces in `to_ref.json` per type:**
- `landingFlaps`: 1–2 entries `{name, frac, default?}`. Exactly one has `default:true`; `frac` = CLmax as a fraction of the maximum landing flap (1 for the max flap, about 0.92 for the other).
- `autobrake`: 1–6 entries `{name, decel}`, with `decel` in m/s² ascending; the last entry is always `{name:"Max manual", decel:null}`.
- `vapp`: `"airbus"` or `"boeing"`.

Families (generic, recalled public operating practice; say so in `_schema`):

| Family | Landing flaps (default *) | Autobrake (m/s²) | VAPP rule |
|---|---|---|---|
| Airbus | 3 (0.92), FULL* (1) | LO 1.7, MED 3.0 | airbus |
| 737 | 30* (0.92), 40 (1) | 1: 1.22, 2: 1.52, 3: 2.19, MAX: 4.27 | boeing |
| 757/767/777/787/747 | 25 (0.95), 30* (1) | 1: 1.22, 2: 1.52, 3: 2.13, 4: 3.05, MAX AUTO: 3.66 | boeing |
| E-Jets | 5 (0.94), FULL* (1) | LO 1.5, MED 2.4, HI 3.6 | boeing |
| ERJ145 | 22 (0.93), 45* (1) | none: Normal 2.0 | boeing |
| CRJ900 | 30 (0.94), 45* (1) | none: Normal 2.0 | boeing |
| C550 | 15 (0.90), 40* (1) | none: Normal 2.0 | boeing |
| G650 | 22 (0.93), 39* (1) | none: Normal 2.0 | boeing |

Every list ends with "Max manual" (`decel:null`).

- [ ] **Step 1: Write the failing test** `"landing reference data per type"`. For every `AC_CODES` entry: `landingFlaps` has 1–2 entries with exactly one default and `frac` in (0.8, 1]; `autobrake` ends with `{name:"Max manual", decel:null}` and the earlier decels are ascending numbers in (0.5, 5); `vapp` is `"airbus"` or `"boeing"`.
- [ ] **Step 2: Run** `node --test tests/toperf.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Add the table to `tools/build_to_ref.py`**, then run `python tools/build_to_ref.py <aircraft_data.xlsx>` (the FAA file is in the scratchpad from the takeoff work). Only the landing fields may change in the existing entries.
- [ ] **Step 4: Run.** Expected: PASS. Then commit with the message "Landing reference data: flaps, autobrake, VAPP rule per type".

### Task L2: Landing model

**Files:** `toperf.js`, `tests/toperf.test.mjs`

**Interfaces:**
- Consumes: `acData` from takeoff, extended by `acFromModel` with `landingFlaps`, `autobrake`, `vappRule`, `tuneLdg:{factor,altK}|null` (from `tune.landing`).
- Produces: `TOPerf.computeLanding(ac, input) → result`.
  - `input = {lwKg, elevFt, qnh, oat, windKt /*signed headwind, raw*/, gustKt /*gust minus steady, ≥0*/, slopePct /*+ uphill on landing*/, ldaFt, wet, reverse:"max"|"idle"|"none", flap:"default"|name, autobrake:"suggested"|name}`
  - `result = {flap, vref, vapp, additive, byAutobrake:[{name, decel, actualFt, arrivalFt, fits}], suggested /*name|null*/, selected /*entry*/, dispatchFt, dispatchOK, ldaFt, airFt, status:"ok"|"tight"|"nofit", notes, tuned}`
  - `status`: `"nofit"` if the selected setting's `arrivalFt > ldaFt`; else `"tight"` if `!dispatchOK`; else `"ok"`.

Rules from the spec:
- VREF = 1.23·VSR(flap), with VSR from the takeoff CLmax_landing × `frac`.
- VAPP additive:
  - airbus: max(5, min(15, hw/3));
  - boeing: max(5, min(20, ½·max(hw,0) + gust)).
- Distances:
  - arrival = actual × 1.15;
  - dispatch = actual(max manual, no reverse, at VREF) / 0.6, × 1.15 when wet;
  - wind is factored 50 % / 150 %.
- Starting constants (each gets a one-line reason in code):
  - air distance = 50 ft / tan 3° + 1.5 s float at touchdown speed; touchdown speed = VAPP − 5 kt (dispatch: VREF − 5);
  - 2 s transition;
  - μ_brake 0.40 dry / 0.20 wet;
  - reverse credit max 0.06 g, idle 0.015 g, none 0.
- Notes: above MLW, an estimated approach speed, an estimated engine.

- [ ] **Step 1: Write failing tests.** Fixture `a20n`, `ldg0 = {lwKg:62000, elevFt:0, qnh:1013.25, oat:15, windKt:0, gustKt:0, slopePct:0, ldaFt:9000, wet:false, reverse:"idle", flap:"default", autobrake:"suggested"}`:
  - `"landing speeds"`: 120 < vref < 150; `vapp - vref === additive >= 5`; FULL gives a lower vref than CONF 3.
  - `"VAPP additive rules"`: Airbus hw 30 → +10, hw 60 → +15. B738 hw 10 with gust 10 → +15; a large gust → +20; tailwind −10 → +5.
  - `"longer when heavier, higher, hotter, downhill, tailwind, wet, gentler autobrake"`: compare `selected.actualFt` with `autobrake` fixed to "LO" (B738: "2"); for "gentler", LO > MED.
  - `"suggested autobrake is the lowest that fits"`: on a 5,500 ft LDA the suggestion's arrivalFt ≤ ldaFt, and the setting before it does not fit.
  - `"dispatch and status"`: `dispatchFt > selected.actualFt`; on LDA = 1.05 × arrivalFt of MED with a long dispatch requirement → status "tight"; on LDA 3,000 ft → "nofit".
  - `"robust"`: for every type × {MLW, 2·MLW} × {SL, 9,000 ft 35 °C} × {ldaFt −100, 0, 9000}, there is no NaN, and `ldaFt` clamps to ≥ 0.
  - `"above MLW note"`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `computeLanding` and its helpers, reusing `atm`/`isaAt`/range checks from takeoff (factor the shared input sanitising into one helper if it stays readable).
- [ ] **Step 4: Run.** Expected: PASS. Then commit with the message "Landing model: VREF/VAPP, autobrake, actual and factored landing distance".

### Task L3: Tuning A20N and B738 landing

**Files:** `data/to_tune.json`, `tools/fit_to_tune.mjs`, `toperf.js` (`landingTuningReport`), tests.

**Interfaces:** `TOPerf.landingTuningReport(ac, points) → [{point, modelFt, chartFt, errPct}]`. The model figure is the dispatch distance (no wind, level, ISA + point.isaDev, wet per point, default flap), and points are `{massKg, paFt, isaDev, wet, lengthFt, doc, rev, page, chart}`.

- [ ] **Step 1: Write the failing test** `"tuned landing matches the charts within 5 %"` (≥ 3 points per tuned type).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Digitise the charts.**
  - Airbus AC 3-4-1 page 5 (FIGURE-3-4-1-991-012-A01, PW engines, ISA): sea level, 4,000 and 8,000 ft at 3–4 weights.
  - Boeing D6-58325-7 3.4.3 (PDF p111, flaps 30): dry and wet at sea level, 4,000 and 8,000 ft.
  - Use the same scratchpad digitisers as for takeoff. Extend `fit_to_tune.mjs` to fit `landing` the same way: geometric factor, altK only if a residual is above 5 %.
- [ ] **Step 4: Run** the fit and the tests. Expected: PASS with the residuals printed. Then commit with the message "Tune A20N/B738 landing distance to airport-planning charts".

### Task L4: Landing side of the view

**Files:** `takeoff.js`, `index.html`, `shell.js`, `styles/app.css`, `tools/ui_check.mjs`, tests.

**Interfaces (function declarations in takeoff.js):**
- `toLandingInputs(X, end, overrides, opts) → {input, src}`.
  - LDA = `r.length − (e.dthr||0)`.
  - Slope = `(o.elev − e.elev)/r.length·100`.
  - Wind and gust come from `X.briefs.arr.met`; the source tag is `"METAR hhmmZ (now)"`.
  - Weight = `X.sel.land`.
  - Same range rules and `byRwy` overrides as takeoff, with the extra range `ldaFt` [1, 25000].
- `landingResult(X) → {ac,input,src,opts,end,B,approach,result} | {ga} | {pending} | {error} | {norunway}`.
  - The end is the chosen approach's runway (`chosenApproach(B).sel.rwy` via `rwyKey`), else `B.best`.
- `takeoffView(X)` renders a header switch: Departure (takeoff) / Arrival (landing), stored in localStorage `xperf.to.side`.
- Landing options are stored in `xperf.ldg.opts` `{flap, autobrake, reverse}`; overrides live in `X.toState.ldg`.
- `landingSetupRow(X)`; `X.landing = landingResult(X)` is set in `render()` next to `X.takeoff`.
- The view label becomes "Takeoff & landing" in `Shell.VIEWS`, the sidebar, the More sheet and `ui_check`'s phone-tabbar list.

- [ ] **Step 1: Write failing tests**, built like the takeoff `toInputs` tests:
  - METAR values and gust flow through with sources;
  - no METAR → ISA, calm, Dry, all "assumed — no METAR";
  - LDA subtracts the displaced threshold;
  - out-of-range overrides are ignored;
  - GA → `{ga:true}`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the view to the addendum's UI section:
  - big numbers: VREF, VAPP (accent) with "+N kt (rule)", flaps, autobrake;
  - a runway bar from the threshold (LDA, air distance, stop point, ×1.15 marker, dispatch marker);
  - a limits list, the autobrake table and the accuracy callout;
  - the approach name with "change the approach in FS2024 setup".
  - Focus restore and "—" for infinite values work as on the takeoff side.
- [ ] **Step 4: Run tests and syntax checks, then look at it** in both themes and at phone width (A20N KSFO→KLAX, B738, C172), and check the interactions in the pane. Commit with the message "Takeoff & landing view: landing side".

### Task L5: Summaries

**Files:** `takeoff.js`, `overview.js` (only if the tile call changes), `nav.js:694-715` (one box in §5), `index.html`.

- [ ] **Step 1:** The takeoff tile becomes two halves (`tile split` style). Left: takeoff as today. Right: "Landing · <rwy>", "VAPP <n> kt", "<flap> · autobrake <x>", or "Does not fit" in `--bad`. The §5 box shows "Landing data · estimate", "VREF / VAPP", "flaps · autobrake". GA plans show neither.
- [ ] **Step 2: Verify** that the values match the view and that clicking opens the view on the Arrival side. Screenshot. Commit with the message "Landing summary on Overview and in FS2024 setup".

### Task L6: Whole-app verification

- [ ] Run `node --test` on all test files, naming each file explicitly. Expected: all pass.
- [ ] `node tools/regress.mjs compare --port <free>` (port-rewritten local fixtures). Expected: 6/6 identical.
- [ ] Run `node tools/ui_check.mjs --mode server`, then `--mode packs`, one at a time, in the background. Expected: all pass; any timeout is re-run alone before it's judged.
- [ ] Restore `.claude/launch.json` and remove the copied fixtures and packs. Report the tuning residuals and screenshots.
