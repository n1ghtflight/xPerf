# XPerf redesign — design

Date: 2026-10-16 · Status: draft for owner approval · Project 1 of 3 toward the public web release
(2 = web version/hosting, 3 = own GA performance table, already running in a separate session).

## Intent and why

XPerf will be posted as a **free web app on a flight-sim forum**, and forum members should see it for the first
time in a design that looks like an app built in 2026: calm, dense but airy, fast to operate, glanceable. The owner
liked the visual, chart-heavy output (profile/terrain graph) and wants **minimal scrolling, suggested defaults with
the option to override, and real data**. The visual language is the owner's house style **nightflight-ui**
(user-level skill at `~/.claude/skills/nightflight-ui/`: `SKILL.md`, `assets/tokens.css`, `assets/shell.html`,
`references/components.md`, `scripts/verify_ui.mjs`), itself measured from the Linear desktop app.

## Goals

1. Re-skin and re-lay-out the whole UI in nightflight-ui: tokens, depth model, type, density, one accent, hairlines.
2. New shell (**layout C**, chosen by the owner): dark sidebar with named views + one raised work surface.
3. **Setup folds into editable chips** after the first plan (chosen by the owner); each chip edits its value and
   re-plans immediately.
4. New **Overview** view: bento of tiles summarising the plan; each tile opens its detail view.
5. Works on **desktop, iPad and phone** (owner requirement); on phones, a **bottom tab bar** (chosen by the owner).
6. **Ctrl/Cmd+K command palette** and keyboard shortcuts.
7. Light + dark themes following the OS, with a toggle.

## Non-goals

- No new planning features, no changes to calculations, data sources or the server API.
- No kneeboard mode, no saved-plans library, no accounts.
- Not the web hosting work (packs by default, METAR/TAF helper, PWA install, licensing cleanup) — that is project 2.
  The redesign must keep working in both data modes the app has today (local server, and `?data=packs`).

## Anti-goals (failure even if it "works")

- **Any planning number changes** on the three test flights: C172 KPAO→KTRK (terrain warning), SR22 EGTF→LFPN
  (non-US), B789 KJFK→EGLL (airways/long-haul). Compare cruise level, times, distances, fuel, TOC/TOD, warnings,
  nav log and .PLN output before vs after.
- A feature that exists today becomes unreachable (every current card, picker, plate viewer, briefing, export).
- The new design is slower to operate than today (more clicks for common changes, slower first result).
- Linear's name, logo, icons or assets appear anywhere in the product.

## Constraints

- Stack stays: vanilla HTML/JS, no build step, no npm deps (AGENTS.md). Python server unchanged.
- All data access through the `XD` adapter in `data.js`; never `fetch('/api/…')` directly.
- Bump `?v=` on script tags when a JS file changes; preserve CRLF where files use it; commit as `n1ghtflight`.
- Edit large blocks with scripted, assert-once replacements (HANDOFF.md gotchas); syntax-check JS after edits.
- Use nightflight-ui tokens for every colour/size/radius/duration; aviation colours (VFR/MVFR/IFR/LIFR, terrain,
  map water/land) stay XPerf's own semantic tokens, defined in both themes (pattern already in
  `design/tokens-linear.css`, commit ff40c00).
- Fonts: Inter, with system fallback; for the web release it may load from Google Fonts or be bundled — bundling is
  preferred so the later desktop/PWA work needs no change.

## Decided by the owner

- **Layout C:** sidebar (views) | raised surface. Before the first plan the surface shows the full setup form.
  After planning, setup folds into one **summary line of chips** above the results, which then get the full width.
- **Editable chips:** `C172 · KPAO → KTRK · Direct · VFR · ETD 12:00Z · All settings`. Option chips (rules,
  navigation mode, optimise, level) open a small menu with single-letter shortcuts; airport and aircraft chips open
  a type-to-search box. **Picking a value re-plans immediately.**
- **Phones:** bottom tab bar — Overview · Route · Airports · Profile · More (More = Fuel & levels, FS2024 setup,
  Settings).
- **iPad and phone must work well** (in-flight / kneeboard-style use).
- **Typed plans in Ctrl+K:** typing e.g. `KPAO KTRK C172` (ICAO, IATA or local/alias codes; aircraft optional,
  `→`/`-`/`to` separators tolerated) offers "Plan KPAO → KTRK in C172" and Enter plans it. Resolve airports
  with the existing `aptSearch`/`resolveApt` logic and aircraft with the `acpicker.js` list. When a code is
  ambiguous, list the candidates as palette rows (name, country) instead of guessing. Without an aircraft,
  keep the current one.
- Carried over unchanged from `HANDOFF_WINDOWS_APP.md` Part 1 (owner agreed): views Overview · Route & nav log ·
  Airports & weather · Profile · Fuel & levels · FS2024 setup · Settings (replacing today's tabs, remembering the
  last view via `xperf.tab`); Overview tiles = map hero, optimum cruise with per-level bars, flight time | distance,
  fuel stacked bar (trip/reserve/landing), cruise wind (arrow + head/tail), climb & descent sparkline with TOC/TOD and
  terrain-conflict dot, departure + arrival weather (flight-category badge, wind/vis/ceiling/temp-QNH, runway in use
  with head/crosswind and distance required vs available); warnings as one compact callout with "Show on profile →";
  setup controls = aircraft card (type badge, name, engine/MTOW, source chips), two large ICAO fields with resolved
  name/elevation and a swap button, segmented controls instead of selects, O₂-limit toggle, Plan flight (Ctrl+Enter);
  Ctrl+K actions such as "Plan KPAO → KTRK in C172", jump to view, change aircraft, export .PLN, toggle theme.

## Calls made in design (the owner can overrule while reading)

- **"All settings"** opens a side panel sliding over the left of the surface (results stay visible); it holds the
  rarer fields: takeoff weight/payload, extra fuel, alternate, ETD, optimise for, manual level, O₂ limit, level rules.
- **Re-plan mechanics (no planning refactor):** chips write into the existing (now hidden or "All settings") form
  fields, which stay the single source of truth that `calculate()`/`planProfile()` read, then call `calculate()`
  exactly as today, so it refetches everything and numbers can't drift. While it runs, the current tiles stay visible,
  dimmed with an "updating" state; everything swaps in together when `calculate()` finishes. No partial/interim
  figures, no new caching of winds/terrain/airport info (no stale forecasts). Restructuring `calculate()` or
  `planProfile()` is out of scope.
- **First visit:** a one-line "For flight simulation only — not for real-world navigation" under the setup form
  (also in Settings). The fuller disclaimer/credits screen belongs to project 2.
- **Airports & weather:** list → detail. List = DEP · ARR · ALT rows (flight-category badge, wind, runway in use);
  detail = today's airport card (summary strip, METAR + TAF timeline, runway diagram + distance bars, runway table,
  ILS + minimums, charts/plate viewer, frequencies, radio aids). Phone: list, tap opens detail.
- **Route & nav log:** map on top, leg-by-leg log as a proper table (tabular numbers, frequencies per leg) below;
  route/published-route pickers stay in this view.
- **Profile:** large chart tile + phases table tile + stat list tile (as in `design/mockup.html` Profile view).
- **Fuel & levels:** cruise-level comparison and fuel breakdown as tiles/charts.
- **FS2024 setup:** keeps its five collapsible sections (world map/EFB with .PLN download, departure briefing,
  cockpit, radio log, arrival briefing) and their remembered state; restyled, not restructured.
- **iPad:** landscape = desktop layout; portrait = sidebar collapsed to icons (tap to expand).
- **Touch:** everything that is hover-only today (map dots, cruise-level chart, winds layer, TAF timeline) also works
  by tap (sticky tooltip, tap elsewhere to clear); copy says "tap" on touch devices.
- **.PLN on iPad/phone:** keep the `Blob` download; mobile browsers route it to Files/Share. (Native share sheet is
  out of scope.)
- **Command palette contents:** contextual group first (actions on the current plan: export .PLN, copy route,
  swap DEP/ARR, rules/navigation/aircraft changes), then Navigate (G then O/R/A/P/F/S), then App (theme, sidebar).
  Shortcuts appear as keycaps in the palette and in tooltips.
- **Theme:** follows the OS; toggle cycles system → dark → light, stored per viewer.
- **Device testing in this project = emulation.** `server.py` stays bound to 127.0.0.1, so verification uses
  `scripts/verify_ui.mjs` plus CDP device emulation of *planned* flights (verify_ui.mjs alone only renders the
  initial page; drive a plan first, e.g. via a small CDP script or URL parameters if the builder adds them).
  Real iPad/iPhone Safari checks (tap tooltips, `.PLN` to Files, safe areas, `100dvh`) happen in project 2 once
  the site is hosted; build with those in mind (`env(safe-area-inset-*)`, `dvh` units, no hover-only actions).
- **Not a desktop window.** The Windows MSI/WebView2 app is shelved by the owner ("scratching off the local install
  for now"). Build a plain web title bar: no frameless drag regions, window-control space or Mica transparency.
  `AGENTS.md` and `HANDOFF_WINDOWS_APP.md` still call the MSI "current work"; update those lines when this
  project starts. Bundling Inter and Leaflet locally is still welcome (it helps the PWA in project 2) but optional.

## Left to the builder

- Exact implementation of the shell inside `index.html` (start from `assets/shell.html`; CSS may move to
  `styles/tokens.css` + `styles/app.css` as `HANDOFF_WINDOWS_APP.md` suggests — no build step).
- How `render()` (index.html ~1076) is split into an Overview renderer plus per-view renderers; reuse the values
  `render()` already computes rather than recomputing.
- Restyling `nav.js` card builders (`airportCard`, `setupCard`/`setupCardHtml`, `navLog`, `departureBriefing`,
  pickers, plate viewer) by changing emitted classes/wrappers only.
- Moving `charts.js` hard-coded colours (e.g. `#0f1720`, `#ffb547`, `#ff6b6b`, `#e6edf3`, `#9aa7b4`) and the profile
  SVG (`profileSVG`, index.html ~1222) to tokens so they follow the theme.
- Leaflet: dark tiles keep the CSS filter, light theme drops it; route line in accent.
- Chip menus and search boxes reuse the existing aircraft combobox (`acpicker.js`) and airport search (`aptSearch`,
  `resolveApt`) logic.
- Order of work and how to stage commits.

## Where things are today (pointers)

- `index.html` (1261 lines): styles in one `<style>` block (lines 7–210); Leaflet from cdnjs (line 212); tabs via
  `TABS`, `currentTab()`, `tabBar()`, `showTab()` (~1060–1075); `render(X)` builds tab panels `setup`, `route`,
  `airports`, `profile`, `fuel` (~1076–1220); `calculate()` (~897) and `planProfile()` (~965) are the planning
  core and must not change behaviour.
- `nav.js` (927 lines): map, routers, airport briefs/cards, setup card, briefings, pickers, plate viewer.
- `charts.js` (208 lines): winds layer, level chart, runway diagram, distance bars, fuel chart, TAF timeline.
- Script tags with `?v=` versions: index.html lines 270–274.
- Design references: `design/mockup.html` (layout reference, older visual skin), `design/tokens-linear.css`
  (measured tokens, XPerf aviation colours), the nightflight-ui skill files listed above.
- localStorage keys in use are listed in `HANDOFF.md`; keep them working (add new ones with the `xperf.` prefix).

## Done means

1. All views reachable on desktop (1440×900), iPad (landscape and portrait) and phone (390×844), both themes,
   with `scripts/verify_ui.mjs` reporting no horizontal overflow and Ctrl/Cmd+K opening the palette.
2. The three test flights produce identical numbers, warnings, nav logs and .PLN output before/after, in both
   data modes (local server, `?data=packs` with server fallback).
3. Every feature reachable today is reachable after (checklist built from today's tabs and cards).
4. Chip edits re-plan; "All settings" covers every field the old form had.
5. Screenshots of each view in both themes are reviewed with the owner before merging.
6. Anything nightflight-ui turned out to be missing (e.g. chip-menu pattern, phone tab bar, PWA notes) is added
   back into the skill.
