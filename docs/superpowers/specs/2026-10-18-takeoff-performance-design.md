# Takeoff performance view — design

Status: draft for the owner's approval (2026-10-18). Landing is a later, separate step.

## Intent

Pilots flying airliners in MSFS 2024 want the takeoff numbers they type into the FMC/MCDU — V1, VR, V2,
reduced-thrust temperature (Airbus "FLEX", Boeing "assumed temperature") and takeoff flaps — for the runway
they will actually use, without re-entering what XPerf already knows (aircraft, takeoff weight, departure
runway, METAR). Reference tools (perfcalc.pradz.de for a few Airbus types, the FlyByWire flyPad, Toper) show
what pilots expect; XPerf's angle is: every OpenAP airliner, pre-filled from the plan, honest about accuracy.

Many study-level aircraft (Fenix, iniBuilds A320neo V2, PMDG 737) have their own EFB calculator. XPerf's
numbers are for the aircraft that don't, for planning and cross-checking. **For simulation only.**

## Decisions made by the owner

- **Scope:** all 37 OpenAP airliners as clearly labelled estimates, plus **per-type tuning for A320neo (A20N)
  and 737-800 (B738)** against the manufacturers' free airport-planning documents.
- **Takeoff first.** Landing (VREF/VAPP, autobrake, landing distance) is a second step, not in this spec.
- **Airports view unchanged.** Its runway "fits?" column and `basePerf()/runwayPerf()` keep their current
  numbers. Switching them to the new model is a later decision after tuning is checked.
- **Readout in the house style:** large clean numbers and a runway bar, not an MCDU replica.

## Goals

1. A new view **Takeoff** (sidebar between "Airports & weather" and "Profile"; chord `G T`; phone: under More)
   that computes, for the chosen departure runway:
   V1 / VR / V2, reduced-thrust temperature (or "TOGA only"), recommended flaps, required vs available runway,
   one-engine-out 2nd-segment climb gradient, thrust reduction %, and a table for every takeoff flap setting.
2. Inputs pre-filled from the plan, each showing its source, each overridable in the view.
3. Options: flaps (Optimum + the type's detents), thrust (reduced / full), packs on/off, anti-ice
   off / engine / engine+wing, runway Dry / Wet, intersection ("runway already behind you", m or ft),
   line-up allowance (none / 90° / 180° turn).
4. Read-only summaries linking to the view: an **Overview tile** and one line in **FS2024 setup §3 Cockpit**.
5. A tuning report showing how far the model is from the manufacturer charts for A20N and B738.

## Non-goals (v1)

Landing; trim / THS / TO SHIFT (XPerf has no CG — skip, show nothing rather than a guess); obstacle-limited
weights; VMCG / VMCA / VMBE / tyre-speed limits; contaminated runways; thrust-reduction / acceleration
altitudes; F / S / green-dot speeds; GA-table aircraft (they keep the Airports-view SS7 numbers; the Takeoff
view says so); real manufacturer FLEX tables; any code or data copied from pradz, FlyByWire (GPL-3) or EFBs.

## Anti-goals (would make it a failure even if it works)

- Numbers that look certified. Every result carries "XPerf estimate · for simulation only" and the accuracy line.
- Silent fallbacks. If a type has no published approach speed, the view says which proxy it used.
- Changing any existing plan number. `node tools/regress.mjs compare` must stay identical.

## Data

| Input | Source in XPerf |
|---|---|
| Wing area, clean polar `cd0`/`k`, gear `Δcd0`, `nEng`, MTOW, MLW | OpenAP aircraft YAML (`m.ac`) |
| Static thrust per engine, bypass ratio | OpenAP engines.csv (`m.eng.max_thrust`, `m.eng.bpr`); estimated-engine types flagged |
| Takeoff weight | plan `X.sel.tow` |
| Runway end, length (= TORA), heading, end elevations → slope, surface | `chosenDepRunway(X.briefs.dep)` (nav.js) |
| OAT, QNH, wind, wet | `X.briefs.dep.met` (decoded METAR; wet = precipitation) |

New data files (small, sourced per value like `data/ga_perf.json`):

- **`data/to_ref.json`** — per OpenAP type: approach/reference speed at MLW (kt) from the **FAA Aircraft
  Characteristics Database** (public domain), the takeoff flap detents and naming family, and the
  reduced-thrust label. Where the FAA table lacks a type: proxy from WRAP `ld_v_app` (touchdown speed),
  marked `est`.
- **`data/to_tune.json`** — for A20N and B738 only: digitised points from the manufacturer airport-planning
  takeoff runway-length charts (Airbus "A320 Aircraft Characteristics – Airport and Maintenance Planning",
  A320neo engine variant matching OpenAP's PW1127G; Boeing "737 Airplane Characteristics for Airport
  Planning", 737-800 / CFM56-7B26): weight, pressure altitude, temperature, flap setting, runway length,
  each with document, revision, page and chart. Facts read from charts and cited; no images or text copied.
  Plus the fitted tuning factors (below).

## Model (pure, no DOM — new file `toperf.js`)

Generic transport-category jet takeoff, evaluated per flap setting. Units SI internally.

1. **Atmosphere** from field pressure altitude (elevation + QNH) and OAT; density for speeds, assumed
   temperature for thrust only (as in real reduced-thrust ops).
2. **Stall speed.** `CLmax_landing` back-solved from VREF at MLW with VREF = 1.23 VSR.
   `CLmax_TO(flap) = CLmax_landing × fraction(flap)` — generic fractions per flap position (low / mid / high),
   in `toperf.js` with their rationale. `VSR = √(2W / (ρ S CLmax_TO))`.
3. **Speeds.** V2 = 1.13 VSR. VR = V2 − ΔVR (generic, a few kt). V1 = balanced-field V1 (step 6), capped
   at VR, floored at a generic fraction of VR (stand-in for VMCG; labelled "not modelled").
4. **Thrust** per engine: static thrust × Bartel & Young speed lapse (as in `climbThrust`) × pressure ratio
   lapse; flat-rated to ISA+15 at the field, generic lapse per °C above. Bleed penalties (generic %):
   packs on, engine anti-ice, engine+wing anti-ice.
5. **Ground run** integrated in speed steps: thrust − drag (cd0 + flap Δcd0 + gear + k·CL²,
   ground-roll CL per flap) − rolling friction (μ 0.02 dry / 0.025 wet), with wind (headwind 50 %,
   tailwind 150 % as in FAR practice) and slope (gravity component).
6. **Field length** for a candidate V1:
   - accelerate-go: all engines to V1, one engine out to VLOF, air segment to screen height
     (35 ft dry, 15 ft wet) at the one-engine-out gradient;
   - accelerate-stop: all engines to V1, 2 s at V1, braking to stop (μ_brake dry / wet; wet allows
     reverser credit), no reversers on dry;
   - all-engines distance to 35 ft × 1.15.
   Required = max of the three; V1 = the value minimising it (balanced).
7. **Available** = runway length − intersection distance − line-up allowance (none 0, 90° turn ≈ one
   fuselage length, 180° ≈ wingspan-derived; generic, shown).
8. **2nd-segment gradient** one engine out, gear up, takeoff flaps, at V2; minimum 2.4 / 2.7 / 3.0 % for
   2 / 3 / 4 engines.
9. **Reduced-thrust temperature** = highest assumed temperature ≥ OAT and ≥ flat-rating temperature where
   field length fits, the gradient is met and thrust ≥ 75 % of full (FAA AC 25-13), capped at ISA+55.
   If none: "TOGA only" (still show speeds at full thrust); if full thrust doesn't fit: "Does not fit" in red,
   with the shortfall.
10. **Optimum flaps** = the setting with the highest reduced-thrust temperature (ties → lower flap).
11. **Tuning (A20N, B738):** one multiplicative field-length factor per type (and optionally an altitude term)
    fitted by least squares to `to_tune.json` points at full thrust, dry, zero wind/slope. Applied to all
    field lengths of that type. Untuned types use factor 1.

API sketch: `TOPerf.compute(acData, input) → {byFlap:[{flap,v1,vr,v2,assumedT,thrustRed,required,
available,goDist,stopDist,grad2,limits}], optimum, notes}`; `TOPerf.tuningReport(type)` for the test.
Performance target: one full recompute (all flaps, temperature search) under 100 ms in the browser —
bisection on temperature and on V1, not brute-force sweeps.

## UI (nightflight-ui house style; mockup in the session notes, `takeoff-landing-mockup.html`)

View header: title "Takeoff", subtitle `KSFO 28R · A20N`, badge "XPerf estimate · for simulation only"
(tuned types: "tuned to Airbus/Boeing airport-planning charts").

Two columns, stacking on phones:
- **Left — inputs.** "From your plan": aircraft, TOW, runway (select, defaults to the FS2024-setup choice),
  elevation/slope, OAT/QNH, wind with head/cross components, runway state; each with a source tag
  (OpenAP / plan / setup / METAR hhmmZ) and editable. Edited values show "edited · reset". "Options":
  segmented controls for flaps, thrust, packs, anti-ice, Dry/Wet; intersection and line-up fields.
- **Right — results.** Big numbers: V1 · VR · V2 · reduced-thrust temperature (accent colour, the one value
  that matters) · flaps. Runway bar: available length, intersection/line-up hatched at the start,
  go and stop distances, V1 mark, margin. "Limits checked" list (field length, 2nd segment, thrust reduction
  ✓/✗ with values; "Obstacles, VMCG/VMBE/tyre speed — not modelled" in warn). Table of every flap setting,
  optimum highlighted. Accuracy callout.

Summaries: Overview tile "Takeoff · 28R" (temperature + flaps + speeds, opens the view); FS2024 setup §3
Cockpit gets one row with the same values. GA aircraft: view shows a short note pointing to Airports.
No METAR: OAT = ISA, wind calm, Dry, all marked "assumed — no METAR"; the user can type values.

Units: kg for weight (as elsewhere), ft primary with m secondary for distances (matches the Airports table),
kt, °C.

## Integration rules (AGENTS.md)

- No new data fetches outside `XD`; the two JSON files load the way `data/ga_perf.json` does (static file,
  works in server and packs modes; add to the static build/service-worker lists if those enumerate files).
- New `toperf.js` and the view code (in a new `takeoff.js`, or nav.js if it's small) get `?v=` tags; register
  the view in `Shell.VIEWS`, `CHORDS` (`t`), the sidebar, the More sheet and the palette.
- CRLF files keep CRLF. No calculation change to the existing plan or Airports view.

## Testing / acceptance

- `tests/toperf.test.mjs` (node --test, vm-loaded like blueprint.test.mjs): monotonic sanity
  (heavier / hotter / higher / tailwind / uphill / wet → longer or lower temperature; headwind → shorter;
  wet → lower V1), reduced-thrust temperature ≥ OAT, 25 % cap respected, "TOGA only" and "does not fit"
  cases, every OpenAP type computes without NaN at MTOW, recompute time.
- Tuning: A20N and B738 field length within **±5 %** of every digitised chart point; residuals printed.
- Spot check (not a gate): A320/A20N ~70 t, sea level ISA, long runway → speeds within about ±8 kt of
  commonly published sim figures; documented in the tuning report.
- Existing: regress compare identical; existing node tests pass; `ui_check` run once in each mode;
  screenshots both themes + phone width.

## Left to the builder

Exact generic constants (flap CL fractions, Δcd0, bleed %, braking μ, ΔVR, V1 floor) with a one-line reason
each; numerical method; how overrides are held in view state; exact file split; tile/row wording.

## Calls made in this design (owner to check)

1. **Contaminated runways left out of v1** (only Dry/Wet) — slush/standing-water drag isn't honest yet.
2. **Trim skipped** entirely (no CG in XPerf).
3. Reference approach speeds from the FAA Aircraft Characteristics Database for all 37 types.
4. Distances shown in ft with m secondary; weights in kg.
5. Options (flaps/packs/anti-ice/thrust) remembered between flights; typed overrides and intersection reset
   when the plan changes.
6. The departure runway defaults to the FS2024-setup choice; changing it in the Takeoff view updates that
   same choice (one runway per departure across the app).
7. TORA = TODA = ASDA = the runway length on record (no stopway/clearway data); displaced thresholds don't
   shorten takeoff. Wind = the METAR steady wind (gusts ignored for takeoff, as in the Airports view).
8. Above MTOW: results still shown, with a warning line, never blocked.
9. Takeoff results are computed during `render()` with the remembered options, so the Overview tile and the
   setup row have values before the view is opened; edits in the view refresh both.
10. Because the Airports view keeps its simpler check, the Takeoff view says so in one line, so differing
    "required" figures don't look like a bug.
11. If a manufacturer chart needed for tuning isn't freely downloadable for the exact variant, that type
    ships untuned (labelled) and the tuning report says why.

---

# Addendum A — Landing (2026-10-19, draft for approval)

The second step the owner asked for: landing figures in the same view, same labelling, same honesty.

## Intent

Before descent the pilot wants VREF and VAPP for the landing flap, an autobrake setting that stops the
aircraft comfortably on the runway they'll actually land on, and whether that runway is long enough —
both by the planning ("dispatch") rule and at the time of arrival. XPerf knows the landing weight, the
arrival airport, the runway of the approach chosen in FS2024 setup and the arrival METAR. **For simulation only.**

## Decided (owner, relayed by the main session)

- VREF/VAPP with a wind additive, an autobrake choice, landing distance with safety factors.
- Same house style and labels ("XPerf estimate · for simulation only").
- A20N and B738 tuned where the airport-planning landing charts allow; all other OpenAP types as estimates.
- The Airports runway check keeps its numbers (and FS2024 setup §5 keeps its existing line).

## Goals

1. The **Takeoff view becomes "Takeoff & landing"** (same place in the sidebar, same `G T`), with a
   Departure / Arrival switch in its header (remembered). The landing side shows, for the arrival runway:
   VREF, VAPP (with the additive spelled out), landing flaps, suggested autobrake, actual landing distance
   with that autobrake, landing distance available, and two checks: **dispatch** (required = actual with
   max manual braking, no reverse, × 1.67, wet × 1.15 more) and **at arrival** (actual with the chosen
   autobrake and reversers × 1.15).
2. Inputs from the plan, each with its source and editable: landing weight (plan), runway + LDA
   (approach chosen in FS2024 setup; runway length minus displaced threshold), elevation and slope (runway
   ends), OAT / QNH / wind incl. gust (arrival METAR, labelled "now — check ATIS before landing").
3. Options: landing flaps (the type's two landing settings), autobrake (the family's settings, plus
   "Suggested"), reversers (max / idle / none), runway Dry / Wet.
4. Summaries: the Overview takeoff tile becomes a two-half tile (takeoff | landing); FS2024 setup §5
   arrival briefing gets one box (VREF / VAPP · flaps · autobrake).
5. Tuning report for A20N (Airbus AC 3-4-1 landing field length, ISA, PW) and B738 (Boeing D6-58325-7
   3.4.3, flaps 30, dry and wet).

## Non-goals (landing)

Contaminated runways / RWYCC below 5; autoland and overweight-landing procedures (a warning above MLW
only); go-around / approach-climb gradient; brake energy and cooling; steep approaches; GA-table aircraft
(they keep the Airports check); trim. TAF-at-ETA weather (the METAR is shown with its time; typing the
expected values is the way to plan ahead).

## Model (toperf.js, new pure functions next to the takeoff ones)

1. **VSR(landing flap)** from the same CLmax_landing as takeoff (FAA approach speed at MALW = VREF for
   the type's maximum landing flap). The other landing flap uses a generic CLmax fraction (≈ 0.92;
   e.g. Airbus CONF 3 vs FULL, 737 flaps 30 vs 40). **VREF = 1.23 VSR** at the landing weight (EAS).
2. **VAPP** by family: Airbus VLS + max(5, min(15, headwind/3)) kt; Boeing and others
   VREF + max(5, min(20, ½ steady headwind + full gust increment)) kt. Tailwind adds nothing.
3. **Actual landing distance** = air distance from 50 ft at VAPP (generic 3° path + flare float) +
   2 s transition at touchdown speed + braking to stop: deceleration = min(autobrake target,
   braking capability). Capability = μ·g (dry / wet, anti-skid) + reverse credit (max / idle / none)
   + slope term; ground speed = airspeed − headwind (50 % head / 150 % tail factoring as for takeoff).
   Autobrake targets per family are generic published-order values (e.g. Airbus LO ≈ 1.7 m/s²,
   MED ≈ 3.0 m/s²; Boeing 1 … MAX ≈ 1.2 … 4.3 m/s²), each named in the code with its reason.
4. **Dispatch landing distance required** = actual(max manual braking, no reverse, VREF-based) / 0.6,
   wet × 1.15 (CS/FAR 121.195-style), compared with LDA.
5. **At-arrival check** = actual(chosen autobrake, reversers, runway state) × 1.15 ≤ LDA.
6. **Suggested autobrake** = the lowest setting whose at-arrival check passes; none → "Does not fit".
7. Tuning: one factor per tuned type on the distance (fitted to chart points, as for takeoff); the
   same robustness rules (no NaN, out-of-range inputs ignored, infinite → "—").

## UI

Same two-column layout and components as the takeoff side. Results: big numbers VREF · VAPP (accent)
· flaps · autobrake; a runway bar from the threshold: LDA, air distance, actual stop point, ×1.15 marker,
dispatch-required marker; limits list (dispatch, at arrival, above MLW warning, "not modelled" line);
a table of every autobrake setting (actual and ×1.15, fits?). The arrival runway is shown with its
approach name and "change the approach in FS2024 setup" (no second approach picker — one choice
across the app, as for the departure runway).

## Testing / acceptance

Monotonic tests (heavier / higher / hotter / downhill / tailwind / wet / lower autobrake → longer;
headwind → VAPP additive and shorter), VAPP additive caps, suggested autobrake = lowest that fits,
no NaN across all types and extreme inputs, every type computes at MLW. Tuning: A20N and B738 dispatch
distance within ±5 % of every digitised chart point. Existing checks unchanged: regress 6/6 identical,
ui_check both modes (view label and lists updated), screenshots both themes and phone.

## Calls made in this addendum (owner to check)

1. One view, renamed "Takeoff & landing", with a Departure / Arrival switch (as in the first mockup).
2. Arrival runway follows the approach chosen in FS2024 setup; no second picker in this view.
3. Arrival weather = current METAR, labelled as "now"; no TAF interpolation.
4. Default reversers **idle** (common airline practice); default autobrake **Suggested**.
5. Dry / Wet only, as for takeoff.
6. 737 lands with flaps 30 by default (40 offered); Airbus FULL by default (3 offered).
7. VREF/VAPP rounded to whole knots; distances ft first, m second.
