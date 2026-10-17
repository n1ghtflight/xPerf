# XPerf Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin and re-lay-out XPerf in the nightflight-ui house style (sidebar + raised surface, setup folding into editable chips, Overview tiles, phone tab bar, Ctrl+K with typed plans, light/dark) without changing a single planning number.

**Architecture:** The existing form fields (`#ac #dep #arr #nav #alt #etd #load #extra #rules #opt #fl #oxy #go`) stay the single source of truth that `calculate()`/`planProfile()` read. New UI pieces only write into those fields and call `calculate()`. The view mechanism stays the current `.tabpanel[data-tab]` show/hide, extended with `overview` and `settings`. A record/replay regression harness (CDP `Fetch` interception) pins numbers, warnings, nav-log data and `.PLN` output for the three test flights before any UI work starts.

**Tech Stack:** Vanilla HTML/CSS/JS (no build, no npm), Python 3 stdlib server (`python server.py 8770`), Node 24 for tests (`node --test`, CDP over the built-in `WebSocket`), headless Edge.

**Spec:** `docs/superpowers/specs/2026-10-16-xperf-redesign-design.md`

## Global Constraints

- No change to calculations, data sources, `server.py`, `navdata.py` or the `/api` surface; `calculate()` and `planProfile()` bodies are not restructured.
- All data access through the `XD` adapter in `data.js`; never `fetch('/api/…')` directly.
- No build step, no npm/pip dependencies. Bump `?v=` on every script/style tag whose file changed.
- Preserve each file's line endings (several are CRLF); edit large blocks with scripted assert-once replacements (HANDOFF.md).
- Every colour, size, radius and duration comes from a token in `styles/tokens.css`; aviation colours (`--vfr --mvfr --ifr --lifr --terrain --terrain-line --map-water --map-land`) are XPerf tokens defined for both themes.
- Keep every existing element `id` and `data-*` hook inside the results (JS depends on them); restyle by changing classes/wrappers.
- localStorage keys keep the `xperf.` prefix; existing keys keep working (`xperf.tab` values `setup|route|airports|profile|fuel` stay valid).
- No Linear name, logo, icons or assets anywhere in the product.
- Commits as `n1ghtflight <343744594+n1ghtflight@users.noreply.github.com>`, plain-sentence subjects, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test flights (fixed ETD `2026-10-20T12:00` UTC): C172 KPAO→KTRK direct · SR22 EGTF→LFPN direct · B789 KJFK→EGLL airways.

## Review Focus

1. **A second chip edit while a re-plan is still running** → the final results match the *last* choice; no earlier, slower run overwrites it. Test: `ui_check` `chips-race` (Task 4).
2. **A plan that fails** (unknown airport typed into a chip, no route found) → the error appears in the warnings callout and the previous results stay visible, not a blank page. Test: `ui_check` `replan-error` (Task 4).
3. **Long content at phone width** (B789 airway route, long METAR/TAF, long airport names, nav-log table) → no horizontal page scroll; wide tables scroll inside their tile. Test: `ui_check` `overflow` with the B789 plan at 390×844 (Task 8).
4. **Theme switch after a plan** → profile chart, level chart, TAF timeline and map follow the new theme without re-planning. Test: `ui_check` `theme-follow` (Task 6).
5. **Typing in a text field** (airport chip search, palette, form inputs) → single-key shortcuts and `G` chords don't fire. Test: `ui_check` `keys-in-inputs` (Task 7).

---

## File Structure

| File | Responsibility |
|---|---|
| `tools/cdp.mjs` (new) | Headless Edge + CDP helpers shared by the test tools: launch, eval, emulation, record/replay of network responses, `planFlight()` |
| `tools/regress.mjs` (new) | `record` / `compare` the three test flights in `server` and `packs` mode against stored baselines |
| `tools/regress/baseline/*.json` (new, committed) | Expected snapshot per mode × flight |
| `tools/regress/fixtures/` (new, gitignored) | Recorded network responses for deterministic replay |
| `tools/ui_check.mjs` (new) | Named UI checks (views, chips, palette, overflow, themes…), run against replayed flights |
| `tests/palette.test.mjs` (new) | `node --test` unit tests for the typed-plan parser and command filter |
| `styles/tokens.css` (new) | nightflight-ui tokens + XPerf aviation tokens |
| `styles/app.css` (new) | Shell, components, views, Leaflet overrides (replaces the inline `<style>` in `index.html`) |
| `shell.js` (new) | Views/sidebar/phone tab bar, theme, tooltips, global keys, command palette UI |
| `palette.js` (new) | Pure functions: `parseTypedPlan`, `filterCommands` (no DOM) |
| `chips.js` (new) | Summary chips, chip menus/search, "All settings" drawer, `replan()` |
| `overview.js` (new) | `renderOverview(X)` bento tiles + compact warnings callout |
| `index.html` (modify) | New markup skeleton, `planWarnings(X)` extraction, `render()` emitting views, `profileSVG` on token classes, Settings view |
| `nav.js` (modify) | `airportsView(X)` list → detail, class changes in cards/briefings/pickers/nav log |
| `charts.js` (modify) | Hard-coded colours → token classes; tap support for hover details |
| `AGENTS.md`, `HANDOFF_WINDOWS_APP.md` (modify) | "Current work" lines: MSI shelved, redesign + web release in progress |
| `~/.claude/skills/nightflight-ui/` (modify, outside repo) | Add patterns learned (chip menus, phone tab bar, typed-plan palette) |

---

### Task 1: Pin today's numbers (regression harness + warnings extraction)

**Files:**
- Create: `tools/cdp.mjs`, `tools/regress.mjs`, `tools/regress/baseline/` (6 JSON files)
- Modify: `index.html` (extract `planWarnings` from `render()`, ~lines 1081–1109), `.gitignore` (add `tools/regress/fixtures/`), `AGENTS.md` + `HANDOFF_WINDOWS_APP.md` (current-work lines)

**Interfaces:**
- Produces (`tools/cdp.mjs`):
  - `launch({width=1440, height=900, mobile=false, scheme="dark", port=8770, query=""}) -> Promise<Page>`; `Page` has `eval(expr: string) -> Promise<any>` (awaitPromise, returnByValue), `key(key, {ctrl,shift}={})`, `click(selector)`, `type(selector, text)`, `shot(file)`, `setScheme("dark"|"light")`, `setViewport(w,h,mobile)`, `close()`.
  - `record(page, file)` / `replay(page, file)`: CDP `Fetch` interception of every request **not** for the app's own static files (`/`, `*.html|js|css|json` under the app origin except `/api/` and `/packs/`); `record` stores `{method,url,status,headers,bodyBase64}` keyed by `method+" "+url`; `replay` fulfils from the file and throws listing any unknown key.
  - `FLIGHTS = {c172:{ac:"apm:C172",dep:"KPAO",arr:"KTRK",nav:"direct"}, sr22:{ac:"apm:SR22",dep:"EGTF",arr:"LFPN",nav:"direct"}, b789:{ac:"oap:b789",dep:"KJFK",arr:"EGLL",nav:"awy"}}`, `ETD = "2026-10-20T12:00"`.
  - `planFlight(page, flight) -> Promise<string>` drives the form the way `tools/shoot.mjs` does (set `#ac` + change, wait for `MODEL.id`, set `#nav #dep #arr #alt #etd`, click `#go`, wait for `window.LAST_X` or `#err` text) and returns the `#err` text (empty on success).
- Produces (`index.html`): `planWarnings(X) -> string[]`, the exact strings `render()` shows today, in the same order; `render()` calls it.
- Produces (page): `window.regressSnapshot() -> Promise<object>` defined by `tools/regress.mjs` via `eval`, returning `{cruiseFt, totalNM, timeS, tripKg, blockKg, toc:{dNM,tS}, tod:{dNM,tS}, levels:[{ft,tripKg,timeS,allowed}], route:[labels], legs:<X.legs reduced to numbers/idents>, warnings: planWarnings(LAST_X), pln: await buildPLN(LAST_X), inventory}` where `inventory` = sorted unique list of element ids, `data-*` attribute names and `select` ids found under `#results` after the plan. Numbers rounded to 3 decimals.

- [ ] **Step 1: Write `tools/cdp.mjs` and `tools/regress.mjs`** with `node tools/regress.mjs record|compare [--mode server|packs] [--flight c172|sr22|b789]` (default: all modes × flights). `compare` replays fixtures, takes the snapshot and deep-compares with `tools/regress/baseline/<mode>-<flight>.json`, printing each differing JSON path; exit code 1 on any difference.
- [ ] **Step 2: Start the server** — `python server.py 8770` (background). Expected: `Flight Performance Calculator on http://localhost:8770`.
- [ ] **Step 3: Run compare before any baseline exists** — `node tools/regress.mjs compare` → Expected: FAIL "missing baseline … run record first" for all 6.
- [ ] **Step 4: Extract `planWarnings(X)`** — move the `warn` array construction out of `render()` verbatim; `render()` uses `const warn=planWarnings(X)`. Syntax-check the inline script (`node -e` over the `<script>` blocks as in HANDOFF.md).
- [ ] **Step 5: Record** — `node tools/regress.mjs record` → writes 6 fixture files and 6 baselines.
- [ ] **Step 6: Compare twice** — `node tools/regress.mjs compare` (run it two times) → Expected: `6/6 identical` both times (proves replay is deterministic).
- [ ] **Step 7: Sanity-check the harness catches change** — temporarily change `BUFFET_MARGIN` to `1.31`, run `node tools/regress.mjs compare --flight b789` → Expected: FAIL with differing paths; revert, re-run → PASS.
- [ ] **Step 8: Update `AGENTS.md` and `HANDOFF_WINDOWS_APP.md`** — current work = redesign (spec path) then web release; MSI shelved. Add `tools/regress/fixtures/` to `.gitignore`.
- [ ] **Step 9: Commit** — `git add tools/cdp.mjs tools/regress.mjs tools/regress/baseline index.html .gitignore AGENTS.md HANDOFF_WINDOWS_APP.md` → "Add record/replay regression harness and pin test-flight output".

### Task 2: Tokens, base styles and theme

**Files:**
- Create: `styles/tokens.css`, `styles/app.css`, `tools/ui_check.mjs`, `shell.js` (theme part only)
- Modify: `index.html` (remove the inline `<style>` lines 7–210, link the two stylesheets with `?v=`, add `<script src="shell.js?v=…">`)

**Interfaces:**
- Consumes: `tools/cdp.mjs` (`launch`, `replay`, `planFlight`, `FLIGHTS`).
- Produces (`tools/ui_check.mjs`): `node tools/ui_check.mjs [--only name,name] [--mode server|packs]`; a registry `check(name, async ({launch, plan}) => {...})` where `plan(flightKey, opts)` launches with replay and plans; assertion helper `expect(cond, message)`. Exit 1 on any failure; prints PASS/FAIL per check.
- Produces (`shell.js`): `Shell.setTheme(t: "system"|"dark"|"light")`, `Shell.theme() -> string`; stores `xperf.theme`; `system` removes `data-theme` from `<html>`.
- Produces (`styles/tokens.css`): the nightflight-ui token set copied from `~/.claude/skills/nightflight-ui/assets/tokens.css` (v1) plus XPerf aviation tokens with the values in `design/tokens-linear.css`, written with `light-dark()`.

- [ ] **Step 1: Write checks `theme` and `regress-safe`** in `ui_check.mjs`. `theme`: with scheme dark, `getComputedStyle(body).backgroundColor` equals the resolved value of `--bg` (`rgb(9, 9, 10)`); with scheme light it equals `rgb(239, 239, 240)`; after `Shell.setTheme("light")` under a dark OS it is `rgb(239, 239, 240)`. `regress-safe`: spawns `node tools/regress.mjs compare` and expects exit 0.
- [ ] **Step 2: Run** `node tools/ui_check.mjs --only theme` → Expected: FAIL (`Shell` undefined / old colours).
- [ ] **Step 3: Create the two stylesheets and the theme part of `shell.js`**; move every rule from the inline `<style>` into `styles/app.css`, rewritten on tokens (Leaflet overrides kept, dark-map CSS filter only under dark theme).
- [ ] **Step 4: Run** `node tools/ui_check.mjs --only theme,regress-safe` → Expected: PASS.
- [ ] **Step 5: Commit** — "Move styles to nightflight-ui tokens and add theme switching".

### Task 3: Shell — title bar, sidebar views, phone tab bar, iPad portrait

**Files:**
- Modify: `index.html` (body skeleton; `TABS`, `currentTab`, `tabBar`, `showTab`, `render` panel wrappers ~1059–1131), `shell.js`, `styles/app.css`

**Interfaces:**
- Produces (`shell.js`):
  - `Shell.VIEWS = [["overview","Overview"],["route","Route & nav log"],["airports","Airports & weather"],["profile","Profile"],["fuel","Fuel & levels"],["setup","FS2024 setup"],["settings","Settings"]]` (id `setup` kept for FS2024 setup so stored `xperf.tab` values stay valid).
  - `Shell.PHONE_TABS = ["overview","route","airports","profile","more"]`; `more` opens a sheet with `fuel`, `setup`, `settings`.
  - `Shell.showView(id)`; the existing global `showTab(name)` becomes a thin alias (render and nav.js keep calling it). Default view after the first plan: `overview`; before any plan the surface shows the setup form (Task 4).
  - Global keys: `G` then `O R A P F S` → overview, route, airports, profile, fuel, setup; `,` → settings; `[` → toggle sidebar. Ignored while focus is in `input, textarea, select, [contenteditable]`.
- Layout: title bar (sidebar toggle, back/forward of view history, current plan breadcrumb chip, data-status chip with AIRAC/live, theme button); sidebar 244px on the chrome; raised surface; status bar (the old `#status` text moves here). ≥1024 px: full sidebar; 768–1023 px: icon-only sidebar (tap to expand); <768 px: no sidebar, bottom tab bar.

- [ ] **Step 1: Write checks `views`, `view-memory`, `phone-tabbar`, `ipad-portrait`.** `views`: after planning c172, clicking each sidebar item shows exactly one `.tabpanel` with matching `data-tab`, and `G`+letter does the same. `view-memory`: show `profile`, reload, plan → `profile` visible. `phone-tabbar`: at 390×844 mobile the tab bar has 5 buttons labelled Overview, Route, Airports, Profile, More, and More lists Fuel & levels, FS2024 setup, Settings. `ipad-portrait`: at 768×1024 the sidebar width ≤ 64 px and labels are hidden; tapping the toggle expands it.
- [ ] **Step 2: Run** `node tools/ui_check.mjs --only views,view-memory,phone-tabbar,ipad-portrait` → Expected: FAIL.
- [ ] **Step 3: Implement the skeleton and `Shell` view logic**, starting from `~/.claude/skills/nightflight-ui/assets/shell.html`. Overview and Settings panels exist (content in Tasks 5 and 9).
- [ ] **Step 4: Run** those four checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 5: Commit** — "Add sidebar shell, view switching and phone tab bar".

### Task 4: Setup form, editable chips, "All settings" and re-planning

**Files:**
- Create: `chips.js`
- Modify: `index.html` (setup form markup restyled per spec: aircraft card, two large ICAO fields with resolved name/elevation and a swap button, segmented controls for `#nav #rules #opt` backed by the existing selects, O₂ toggle for `#oxy`, Plan flight = `#go` with Ctrl+Enter), `styles/app.css`

**Interfaces:**
- Consumes: global `calculate()`, `resolveApt(id)`, `DB.aptIndex`, `AcPicker` (`sync`, `index`), `#ac` select options.
- Produces (`chips.js`):
  - `Chips.render(X) -> string`: summary line `[aircraft code] [DEP → ARR] [nav mode] [rules] [ETD HH:MMZ] [All settings]`; each chip has `data-chip="ac|route|nav|rules|opt|fl|etd|all"`.
  - Option chips (`nav rules opt fl`) open a menu listing the select's options with single-letter keys (rules: I/V/A; nav: D/V/N/W/P for direct/vor/vorndb/awy/pub; opt: F/T); the `route` chip opens two type-to-search inputs reusing `aptSearch` results; the `ac` chip opens the existing aircraft search.
  - `replan() -> Promise<void>`: adds `body.replanning` (tiles dimmed, `aria-busy`), awaits `calculate()`, removes the class. A newer `replan()` call supersedes an older one: only the latest call's completion clears the state, and since `calculate()` disables `#go`, a second edit during a run is queued and executed once after the current run.
  - "All settings" drawer `#allSettings` holds the full form (same DOM node moved, ids unchanged): before the first plan the form is shown in the surface; after a successful plan it moves into the drawer and the chips appear.
- Error behaviour: if `calculate()` sets `#err`, the previous results stay rendered and the error text is shown in the warnings callout area (`#err` moves into the callout slot).

- [ ] **Step 1: Write checks `setup-first`, `chips`, `chips-race`, `replan-error`, `all-settings`.** `setup-first`: fresh load shows the form in the surface and no `.chips`; the swap button exchanges `#dep`/`#arr` values; with `#dep`/`#arr` filled, Ctrl+Enter starts a plan (`LAST_X` appears). `chips`: plan c172, click `[data-chip=rules]`, pick IFR → `$("rules").value==="ifr"` and `LAST_X` changed (new object) and `body.replanning` cleared. `chips-race`: plan c172, set rules IFR then immediately VFR via chips → final `$("rules").value==="vfr"` and the rendered cruise level equals a fresh VFR plan's `LAST_X.sel.ft`. `replan-error`: via the route chip set arrival `ZZZZ` → callout shows the "Enter valid airport codes" text and the previous Overview tiles are still in the DOM. `all-settings`: drawer contains every id in `["ac","dep","arr","nav","alt","etd","load","extra","rules","opt","fl","oxy","go"]`.
- [ ] **Step 2: Run** those five checks → Expected: FAIL.
- [ ] **Step 3: Implement** the restyled setup form, `chips.js`, the drawer and `replan()`.
- [ ] **Step 4: Run** the five checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 5: Commit** — "Fold setup into editable chips with All settings drawer".

### Task 5: Overview view

**Files:**
- Create: `overview.js`
- Modify: `index.html` (`render()` puts `renderOverview(X)` in the `overview` panel; the old `.kpis` strip and `.warnbox` are removed), `styles/app.css`

**Interfaces:**
- Consumes: `planWarnings(X)` (Task 1), globals `lvl fmtK nm hhmm gcDist decodeMetar windComp` and `X` fields used by today's KPI strip (`sel.ft`, `total`, `sel.time`, `sel.trip`, `sel.block`, `cr.tail`, `cr.dT`, climb/descent `d`/`t`, `X.minFuel`, `X.minTime`, `X.results`, `X.info.dep/arr.wx`).
- Produces: `renderOverview(X) -> string`; each tile carries `data-tile="<name>"` and `data-open="<view id>"` (click/Enter opens that view): `map` → route; `cruise` (level + per-level bars from `X.results`, allowed levels only) → fuel; `time-distance` → route; `fuel` (stacked trip/reserve/landing) → fuel; `wind` (arrow + head/tail from `cr.tail`) → profile; `profile` (sparkline with TOC/TOD and a terrain-conflict dot when `sel.terrain` flags one) → profile; `dep-wx`, `arr-wx` (flight-category badge, wind/vis/ceiling/temp-QNH, runway in use with head/crosswind and required vs available distance from the existing brief data) → airports. Warnings render as one callout: first warning's first sentence + "+N more" + "Show on profile →" (opens profile view, expands the full list there).

- [ ] **Step 1: Write checks `overview` and `overview-values`.** `overview`: after planning c172 the overview panel has the 9 tiles above (by `data-tile`), clicking `[data-tile=map]` shows the route view. `overview-values`: the cruise tile text contains `lvl(LAST_X.sel.ft)`, the time tile contains `hhmm(LAST_X.sel.time)`, the distance tile contains `Math.round(nm(LAST_X.total))`, and the callout count equals `planWarnings(LAST_X).length`.
- [ ] **Step 2: Run** → Expected: FAIL.
- [ ] **Step 3: Implement** `overview.js` and wire it into `render()`.
- [ ] **Step 4: Run** both checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 5: Commit** — "Add Overview tiles and compact warnings callout".

### Task 6: Detail views restyled, Airports list → detail, charts on tokens

**Files:**
- Modify: `nav.js` (new `airportsView(X)`; class changes in `airportCard`, `setupCard`/`setupCardHtml`, `navLog`, `departureBriefing`, pickers, plate viewer), `charts.js` (colours → classes), `index.html` (`render()` panels for route/airports/profile/fuel/setup; `profileSVG` colours → classes), `styles/app.css`

**Interfaces:**
- Produces (`nav.js`): `airportsView(X) -> string`: list rows `data-apt="dep|arr|alt"` (flight-category badge, wind, runway in use) + detail area showing `airportCard` for the selected row; selection stored as `xperf.aptSel`; at <768 px the list shows first and a row opens the detail with a back button.
- SVG colours: elements get classes (`c-grid c-axis c-profile c-profile-fill c-toc c-tod c-terrain c-label c-wind-*`) styled in `app.css` from tokens; no hex values remain in `charts.js` or `profileSVG`.
- Leaflet (`drawMap` in `nav.js`) takes colours as JS values, so it reads them with `getComputedStyle(document.documentElement).getPropertyValue("--accent")` etc. at draw time; the route line is `--accent`, markers get a 1.5px `--panel` outline; on a theme change the map re-applies its styles (no re-plan).
- Views: Route & nav log = map tile on top + nav-log table (tabular numbers, frequencies per leg) + route/published pickers; Profile = chart tile + phases table tile + stat-list tile; Fuel & levels = level chart + comparison table + fuel chart tiles; FS2024 setup = today's five collapsible sections restyled, `.PLN` button first.

- [ ] **Step 1: Write checks `airports-list`, `feature-inventory`, `theme-follow`, `no-hex`.** `airports-list`: c172 plan → airports view has `[data-apt=dep]` and `[data-apt=arr]`; clicking `arr` shows a card containing `KTRK`. `feature-inventory`: every entry of the baseline `inventory` (from `tools/regress/baseline/server-<flight>.json`) exists somewhere in the document after planning each flight. `theme-follow`: after a plan, the computed `stroke` of `.c-profile` changes when `Shell.setTheme` flips dark↔light, without re-planning. `no-hex`: `charts.js` and the `profileSVG` function text contain no `#[0-9a-f]{3,6}` colour literals (read the files from disk).
- [ ] **Step 2: Run** → Expected: FAIL.
- [ ] **Step 3: Implement** `airportsView`, restyle the detail views and move chart colours to classes.
- [ ] **Step 4: Run** the four checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 5: Commit** — "Restyle detail views, add Airports list, put charts on tokens".

### Task 7: Command palette, typed plans and shortcuts

**Files:**
- Create: `palette.js`, `tests/palette.test.mjs`
- Modify: `shell.js` (palette UI, tooltips with keycaps), `styles/app.css`, `index.html` (script tag)

**Interfaces:**
- Produces (`palette.js`, pure, attached to `globalThis`):
  - `parseTypedPlan(text: string, lookups: {aptIndex: Record<string,Apt>, airports: Apt[], aircraft: {value,code,name}[]}) -> {kind:"plan", dep:Apt, arr:Apt, ac:string|null} | {kind:"ambiguous", field:"dep"|"arr", token:string, candidates:Apt[]} | {kind:"unknown", field:"dep"|"arr"|"ac", token:string} | {kind:"none"}`. Tokens split on whitespace; separators `→ -> – - to` ignored. Airport token: exact `aptIndex[token]` (ICAO/ident/IATA/alias) wins; otherwise airports whose ICAO starts with the token, IATA equals it, or name contains it — one match resolves, 2–8 → `ambiguous` (max 8 candidates), 0 → `unknown`. Optional third token is an aircraft code matched case-insensitively against `aircraft[].code`; no match → `unknown` for `ac`. Fewer than two airport-like tokens → `none`.
  - `filterCommands(commands: {label,group}[], query: string) -> same[]`: case-insensitive substring on label, group order preserved.
- Produces (`shell.js`): `Palette.open()`, `Palette.close()`; Ctrl/Cmd+K toggles; groups in order: typed-plan row (when `parseTypedPlan` returns `plan`: "Plan DEP → ARR in TYPE"; `ambiguous`: one row per candidate "DEP = KXXX Name, Country"), **This plan** (when `LAST_X` exists: Export .PLN `E`, Copy route, Swap departure/arrival, Rules: IFR/VFR/Any, Navigation…, Change aircraft…), **Navigate** (G O/R/A/P/F/S, `,`), **App** (theme, toggle sidebar `[`). Running a typed plan sets `#ac` (dispatch `change`, await `MODEL_P`) when an aircraft was given, sets `#dep`/`#arr`, then `replan()`.
- Tooltips: `[data-tip]` + `data-kbd` show label and keycaps after 450 ms (nightflight-ui shell pattern).

- [ ] **Step 1: Write `tests/palette.test.mjs`** (loads `palette.js` with `vm` into a context holding a small airports fixture: KPAO, KTRK, KSFO(IATA SFO), KLAX(IATA LAX), EGLL(IATA LHR), two airports whose names contain "SPRINGFIELD"). Tests: `"KPAO KTRK C172"` → plan KPAO/KTRK/`apm:C172`; `"kpao → ktrk"` → plan, `ac:null`; `"SFO to LAX B738"` → plan KSFO/KLAX/`oap:b738`; `"KPAO SPRINGFIELD"` → `ambiguous` field `arr` with 2 candidates; `"KPAO ZZZZ"` → `unknown` field `arr`; `"KPAO KTRK XX99"` → `unknown` field `ac`; `"export"` → `none`; `filterCommands` keeps group order and matches "pln" to "Export .PLN".
- [ ] **Step 2: Run** `node --test tests/` → Expected: FAIL (`parseTypedPlan` not defined).
- [ ] **Step 3: Implement `palette.js`** → `node --test tests/` → Expected: PASS.
- [ ] **Step 4: Write checks `palette`, `typed-plan`, `keys-in-inputs`.** `palette`: Ctrl+K opens with input focused; first group after planning is "This plan"; Esc closes. `typed-plan`: type `KJFK EGLL B789` + Enter → `LAST_X.dep.icao==="KJFK"` and `MODEL.id==="oap:b789"`. `keys-in-inputs`: focus `#dep`, type `g` then `r` → visible view unchanged; in the palette input the same keys only filter.
- [ ] **Step 5: Run** → Expected: FAIL; **implement** the palette UI and tooltips; **run** the three checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 6: Commit** — "Add Ctrl+K palette with typed plans and shortcut tooltips".

### Task 8: Touch, phone and iPad polish

**Files:**
- Modify: `charts.js`, `nav.js` (map dots), `index.html` (wind layer toggle), `styles/app.css`, `shell.js`

**Interfaces:**
- Hover-only details (map dots, level chart, winds layer, TAF timeline) also open on `pointerup` with `pointerType` touch/pen as a sticky tooltip; tapping elsewhere closes it; copy says "tap" when `matchMedia("(pointer: coarse)")`.
- Layout: `100dvh` instead of `100vh`; `env(safe-area-inset-*)` padding on title bar, tab bar and drawer; wide tables wrap in an `overflow-x:auto` container inside their tile.

- [ ] **Step 1: Write checks `touch-tooltips` and `overflow`.** `touch-tooltips`: emulated 390×844 mobile, plan c172, dispatch a touch tap on the first level-chart bar → a tooltip element becomes visible and contains a level; tap on the surface background → hidden. `overflow`: plan b789 at 1440×900, 1024×768, 768×1024 and 390×844, both themes, and on every view `document.documentElement.scrollWidth <= innerWidth`.
- [ ] **Step 2: Run** → Expected: FAIL; **implement**; **run** both checks plus `regress-safe` → Expected: PASS.
- [ ] **Step 3: Commit** — "Make charts and layout work on touch, phone and iPad".

### Task 9: Settings view, first-visit note, full verification, skill feedback

**Files:**
- Modify: `index.html` (Settings panel; sim-only line under the setup form), `shell.js`, `styles/app.css`, `~/.claude/skills/nightflight-ui/` (`references/components.md`, `assets/shell.html` if useful)

**Interfaces:**
- Settings view: theme selector (system/dark/light → `Shell.setTheme`), data line (`XD.mode`, `await XD.label()`), keyboard shortcuts list, and the "Data sources and model assumptions" block moved from the per-plan `srcnote` (still filled from `LAST_X` when a plan exists), plus the exact line "For flight simulation only — not for real-world navigation." The same line sits under the setup form.

- [ ] **Step 1: Write checks `settings` and `first-visit`.** `settings`: `G` `,` shows the settings view with a theme control whose change updates `<html data-theme>`, and the sim-only sentence is present. `first-visit`: fresh profile shows the sim-only sentence under the setup form.
- [ ] **Step 2: Run** → Expected: FAIL; **implement**; **run** → Expected: PASS.
- [ ] **Step 3: Full verification** — `node --test tests/` → PASS; `node tools/regress.mjs compare` → `6/6 identical`; `node tools/ui_check.mjs` (all checks, `--mode server` then `--mode packs`) → all PASS; `node ~/.claude/skills/nightflight-ui/scripts/verify_ui.mjs http://localhost:8770/ out/verify` → no overflow, palette opens.
- [ ] **Step 4: Owner review screenshots** — for each view × {1440×900, 768×1024, 390×844} × {dark, light} with the c172 plan replayed, save PNGs to `out/review/` (gitignored) and present them to the owner before merging.
- [ ] **Step 5: Skill feedback** — add to nightflight-ui `references/components.md`: editable property chips with option menus/search, phone bottom tab bar with More sheet, typed-plan palette rows (resolve/ambiguous/unknown), "dim and swap" re-plan state. Bump the tokens.css version comment only if tokens changed.
- [ ] **Step 6: Commit** — "Add Settings view and simulation-only note" (repo) — the skill lives outside the repo and is saved in place.
