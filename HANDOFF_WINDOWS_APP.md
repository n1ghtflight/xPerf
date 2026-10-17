# XPerf → Windows desktop app (redesign + installer) · handoff

Written 2026-10-16 to continue in VS Code / GitHub Copilot CLI. **Read `HANDOFF.md` first** (what the app does,
files, API, data sources, gotchas), then this file. Nothing below has been implemented yet; the only new
artefacts are `design/mockup.html` (layout reference), `design/tokens-linear.css` (starting tokens) and
`design/screens/` (mockup screenshots dark/light + `current-app-before.jpg`).

Repo: https://github.com/n1ghtflight/xPerf (public). Commit as `n1ghtflight <343744594+n1ghtflight@users.noreply.github.com>`
(already set in this repo's local git config).

## Goal

1. **Redesign the UI** so it looks like an app built in 2026 — the owner wants a **Linear-style** look
   (linear.app): calm near-black UI, dense but airy, crisp 1px hairlines, Inter, subtle indigo accent,
   keyboard-first, nice-looking **tiles** for the results.
2. **Ship it as an installable Windows app** — `.msi` (an `.exe` setup is acceptable as a fallback).

Order: redesign in the browser first (fast iteration on `python server.py 8770`), then package.

---

## Part 1 — Redesign

### Information architecture (keep from the mockup)

Open `design/mockup.html` (any static server, or `http://localhost:8770/design/mockup.html` while the server runs).
It is a static, data-free mockup with a working dark/light toggle and two views (Overview, Profile). The **layout**
is agreed; the **visual skin** should move from the mockup's Fluent/Windows feel to Linear's.

```
┌ title bar ───────────────────────────────────────────────────────────────┐
│ XPerf / KPAO → KTRK · C172          ● Live data  AIRAC 2610  ☀  – □ ×   │
├──┬──────────────┬────────────────────────────────────────────────────────┤
│▣ │ Flight setup │  KPAO → KTRK                       [Copy route][.PLN] │
│▦ │  aircraft    │  ⚠ compact warning callout (expand → jumps to view)   │
│⇢ │  route       │  ┌ map (hero) ───────┐ ┌ cruise level + level bars ┐  │
│♜ │  nav mode    │  │                   │ └───────────────────────────┘  │
│⌒ │  load/time   │  │                   │ ┌ time │ distance ──────────┐  │
│⛽│  level rules │  └───────────────────┘ └───────────────────────────┘  │
│▭ │              │  ┌ fuel ┐┌ wind ┐┌ climb/descent sparkline ────────┐  │
│  │ [Plan  ⌃↵]   │  ┌ DEP weather + runway ┐┌ ARR weather + runway ───┐  │
└──┴──────────────┴────────────────────────────────────────────────────────┘
 rail                setup panel (collapsible)      main (views)
```

- **Rail views** replace today's tabs (same content, same `xperf.tab` memory):
  Overview (new) · Route & nav log · Airports & weather · Profile · Fuel & levels · FS2024 setup · Settings.
- **Overview = bento grid** (12-col) of tiles; each tile is clickable and opens its detail view.
  Tiles: map hero, optimum cruise (with per-level comparison bars), flight time | distance, fuel (stacked bar:
  trip / reserve / landing), cruise wind (arrow + head/tail), climb & descent sparkline with TOC/TOD and terrain
  conflict dot, departure + arrival weather (flight-category badge VFR/MVFR/IFR/LIFR, wind/vis/ceiling/temp-QNH,
  runway in use with head/crosswind and distance required vs available).
- **Warnings** become one compact callout (title + one line + "Show on profile →"), not a paragraph wall.
- **Setup panel**: aircraft as a card (type code badge + name + engine/MTOW, source chips), departure/arrival as
  two large ICAO fields with resolved airport name + elevation and a swap button, segmented controls instead of
  selects for Navigation / Rules / Optimise, toggle switch for the O₂ limit, sticky **Plan flight** button (Ctrl+Enter).
- Detail views reuse the same tile component (see Profile view in the mockup: big chart tile, phases table tile,
  stat-list tile).

### Linear-style visual language (target)

Public references: Linear's "How we redesigned the Linear UI" (parts I & II) on linear.app/now. Key traits to copy
(spirit, not assets — do **not** use Linear's logo, name, or copied artwork):

| Trait | Do |
|---|---|
| Colour | Near-black neutral background (≈ `#08090a`), surfaces step up in tiny lightness increments; text ≈ `#f7f8f8`; borders = low-opacity white (6–10 %). Build the palette in **LCH/OKLCH** so steps look even. One accent (indigo ≈ `#5e6ad2`/`#7170ff`); semantic green/amber/red used sparingly. Light theme generated from the same tokens. |
| Type | **Inter Variable** (`font-feature-settings:"cv01","ss03"`), 13 px base UI, 12 px meta, medium weight ≈ 510, display numbers 590 with tight tracking; tabular numerals for all figures. Bundle the font locally (OFL licence) — the desktop app must not depend on Google Fonts. Mono: JetBrains Mono or Cascadia Mono for METAR/route strings. |
| Shape | Radius 6–8 px controls, 10–12 px tiles; 1px hairline borders, almost no shadow in dark (a faint inner top highlight instead); light theme gets soft shadows. |
| Density | Compact rows (28–32 px controls), generous outer padding, aligned baselines; no heavy card chrome. |
| Motion | 120–180 ms ease-out; tiles fade/rise 6 px on view change with a small stagger; respect `prefers-reduced-motion`. |
| Interaction | **Command palette (Ctrl+K)**: "Plan KPAO → KTRK in C172", jump to view, change aircraft, export .PLN, toggle theme. Keyboard shortcuts shown in tooltips (G then O = Overview, G R = Route, …). Hover reveals secondary actions. |
| Chrome | Sidebar/rail slightly lighter than canvas, active item = subtle filled pill + accent text; title bar is part of the canvas (no separate coloured bar). |

`design/tokens-linear.css` contains a first-pass token set (dark + light) in this spirit — swap it in for the
mockup's `:root` tokens and tune.

### How to implement in the real app

- Today all CSS lives in a `<style>` block at the top of `index.html` (tokens on lines ~9–11). Move styles to
  `styles/tokens.css`, `styles/app.css` (shell, rail, setup panel, tiles), keep Leaflet overrides.
- `render()` in `index.html` builds results HTML strings; `nav.js` builds the airport/setup/route cards and
  `charts.js` the SVG charts. Re-skin by **changing the emitted class names / wrappers**, not the calculations.
  Add an `overview` renderer that composes the bento from the values `render()` already computes.
- Charts (`charts.js`) hard-code colours — switch them to `var(--…)` tokens so they follow the theme.
- Leaflet map: dark tiles currently = OSM with a CSS filter; for light theme drop the filter. Leaflet is loaded
  from cdnjs → **vendor it locally** (`vendor/leaflet/…`) so the installed app works without a CDN.
- Keep every data call going through the `XD` adapter in `data.js` (see HANDOFF.md rule) — the iOS/packs build
  depends on it.
- Bump the `?v=` query strings on script tags whenever a JS file changes.
- Verify with `tools/shoot.mjs` (headless Edge screenshots at 1440/1920 px) in both themes and with the three
  standard test flights: C172 KPAO→KTRK (terrain warning), SR22 EGTF→LFPN (non-US), B789 KJFK→EGLL (airways/long-haul).

---

## Part 2 — Windows app + installer

### Recommended architecture

```
XPerf.exe  (.NET 9 WinForms/WPF host, ~200 KB + WebView2 SDK)
 ├─ starts  runtime\python\python.exe server.py <free-port> --data "%LOCALAPPDATA%\XPerf"
 ├─ waits for GET /api/health → 200
 ├─ shows the UI in a WebView2 control (http://127.0.0.1:<port>/)
 └─ kills the Python child on exit (Job Object so it also dies if the host crashes)
```

Why: Python stays the backend unchanged (stdlib only), the UI is the same HTML, and the host gives a real app
window — own icon, taskbar entry, Win11 **Mica** backdrop + dark title bar (DwmSetWindowAttribute
`DWMWA_SYSTEMBACKDROP_TYPE`/`DWMWA_USE_IMMERSIVE_DARK_MODE`), remembered window size/position, single instance.

Checked on this machine: .NET SDK 9.0.319, WebView2 runtime 155 present (ships with Windows 11), Python 3.14.7,
Node 24. Not installed: PyInstaller, WiX, Inno Setup.

### Steps

1. **Make data paths configurable** (required — Program Files is read-only):
   - `server.py`, `navdata.py`: `CACHE_DIR = os.environ.get("XPERF_DATA") or os.path.join(ROOT, "cache")`
     (and accept `--data <dir>`). `ROOT` stays the install dir for static files and `apm_snapshot.json`.
   - `build_packs.py` already takes `--out`.
   - Static files must be served from `ROOT` regardless of the process cwd (check `Handler` / `SimpleHTTPRequestHandler`
     `directory=`).
   - Add `/api/shutdown` (localhost only) or rely on the host killing the process.
2. **Bundle Python** — use the official *Windows embeddable package* (python-3.14.x-embed-amd64.zip, ~10 MB) into
   `runtime/python/`; stdlib only, so no pip. (Alternative: PyInstaller one-folder `server.exe`; embeddable is simpler
   and trips antivirus heuristics less.) Put `navdata.py`, `server.py` next to it or set `._pth` accordingly.
3. **Host app** `win/XPerf.App/` (`dotnet new winforms`, package `Microsoft.Web.WebView2`):
   free port via `TcpListener(IPAddress.Loopback,0)`, start Python hidden (`CreateNoWindow`), poll `/api/health`,
   splash/loading state while the first run downloads ~40 MB of FAA/OurAirports data, WebView2 user data folder in
   `%LOCALAPPDATA%\XPerf\WebView2`, open external links (aeronav plates, SkyVector) in the default browser
   (`CoreWebView2.NewWindowRequested`), **.PLN download** → `DownloadStarting` with a Save dialog defaulting to the
   FS2024 flight-plan folder, app icon (`design/` → make `xperf.ico`), set `AppUserModelID`.
   Publish: `dotnet publish -c Release -r win-x64 --self-contained false` (needs .NET 9 Desktop Runtime) **or**
   `--self-contained true -p:PublishSingleFile=true` (~70 MB, no prerequisite). Prefer self-contained for a
   frictionless install.
4. **Installer** — WiX Toolset v5/v6 (`dotnet tool install --global wix`) project `win/XPerf.Installer/`:
   per-user install to `%LOCALAPPDATA%\Programs\XPerf` (no admin) *or* per-machine to Program Files; Start-menu
   shortcut + optional desktop shortcut, upgrade code fixed (major upgrades), uninstall leaves
   `%LOCALAPPDATA%\XPerf` data unless the user ticks "remove data". Output `XPerf-<version>-x64.msi`.
   Fallback if WiX fights you: Inno Setup → `XPerf-Setup.exe`.
5. **Build script** `win/build.ps1`: fetch embeddable Python (pinned version + SHA256), copy app files
   (exclude `cache/`, `packs/`, `design/`, `tools/`, `.git`), vendor Leaflet + Inter, `dotnet publish`, `wix build`.
6. **Signing**: unsigned MSI shows SmartScreen "unknown publisher". Fine for personal use; for distribution get an
   Azure Trusted Signing / code-signing cert.
7. **Test**: install on a clean user profile, first-run download, offline second run, uninstall/upgrade, two
   instances, port already in use, Python killed when window closes, .PLN save lands where FS2024 sees it.

Licensing reminder (see IOS_PORT_STUDY.md): X-Plane nav data is GPL — keep it out of the bundle (only fetched at
runtime / `--xplane` flag). OpenAP, OurAirports, FAA data are fine to fetch at runtime.

---

## Suggested task order for the next session

1. Data-path refactor (`XPERF_DATA`) + vendor Leaflet/Inter + commit.
2. Tokens (`tokens-linear.css`) + shell (title bar, rail, setup panel) in the real `index.html`.
3. Overview bento renderer, then re-skin each existing tab as a rail view; charts on tokens; light theme.
4. Command palette + shortcuts.
5. `win/` host app → embeddable Python → WiX MSI → `build.ps1`.
6. Update `HANDOFF.md` file table and README.
