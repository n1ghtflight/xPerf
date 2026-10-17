# XPerf — agent instructions

Flight performance & route planner for MSFS 2024: Python 3.14 stdlib server (`server.py`, `navdata.py`) +
vanilla HTML/JS UI (`index.html`, `nav.js`, `charts.js`, `data.js`, `acpicker.js`, `pln.js`). No build step, no npm/pip deps.

**Start here:** `HANDOFF.md` (what exists, API, data sources, gotchas) → `HANDOFF_WINDOWS_APP.md` (current work:
Linear-style redesign + Windows MSI). Layout reference: `design/mockup.html`; tokens: `design/tokens-linear.css`.

## Run / check

- `python server.py 8770` → http://localhost:8770 (the owner's own instance uses 8765; restart after editing `.py`).
- Syntax-check JS after edits: `node -e "new Function(require('fs').readFileSync('nav.js','utf8'))"`.
- Screenshots: `$env:XPORT=8770; node tools\shoot.mjs <outDir> <width> <acId> <dep> <arr> <nav>` (PowerShell).

## Rules

- All data access in the UI goes through the `XD` adapter in `data.js` — never `fetch('/api/…')` directly.
- Bump `?v=` on script tags in `index.html` when a JS file changes.
- Several files use CRLF — preserve line endings.
- `cache/` and `packs/` are generated (gitignored); don't commit them.
- Change presentation, not calculations, during the redesign; compare numbers before/after on the test flights
  C172 KPAO→KTRK, SR22 EGTF→LFPN, B789 KJFK→EGLL.
- Don't use Linear's name, logo or assets in the product — only the design spirit.
- Commit author: `n1ghtflight <343744594+n1ghtflight@users.noreply.github.com>` (set in local git config).
