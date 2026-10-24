# Random flight generator — design

Date: 2026-10-24 · Status: draft for the owner's approval

## Why

When the owner sits down in FS2024 without a destination in mind, XPerf should hand them a flight that is worth flying
*right now*: their chosen aircraft, real live weather of the kind they asked for (snow, rain, low visibility), day or
night as it really is at the airport, and a trip length that fits the session. The weather is the point — they load
FS2024 with live weather and fly into what XPerf found.

## What the owner decided

- **Prompts, all on one panel** (layout A of the mockup, `.superpowers/brainstorm/…/generator-layout.html`):
  1. Aircraft group — **GA** or **Airliner** — then the owner **picks the exact aircraft** inside that group.
  2. Time — **Day · Night · Any**.
  3. Departure weather — **Snow · Rain · Low visibility · Any**.
  4. Arrival weather — **Snow · Rain · Low visibility · Any**.
  5. Distance — **Short · Long · Any**. Short = **up to 2 hours** of flight.
  6. Buttons: **Generate flights** and **Fully random**. Fully random **keeps the chosen aircraft** and treats every
     other prompt as Any.
- **Real live weather**, not a theme: the generator searches airports where the condition is reported now.
- **Weather condition applies at the departure** (the arrival has its own prompt).
- **Anywhere in the world**, constrained only by the weather and day/night answers.
- **Show options**, then the owner picks one; picking it plans the flight the normal way.
- **When nothing matches, show the closest matches**, each labelled with what differs.
- **Where it lives: a "Random flight" button** on the start screen beside the example flights.
- A departure with a weather condition **must be an airport with a live weather report** (accepted by the owner).

## Goals

- From the start screen to a planned flight in two clicks (Generate → pick) with the prompts already set.
- Every option is flyable by the chosen aircraft: within range, enough runway at both ends, and for airliners a
  proper (long, paved) runway.
- Works the same in both data modes — the local server and the public static site (packs + relay).
- The weather shown on an option is the real report it was chosen on.

## Non-goals

- Choosing a random aircraft (the owner always picks it).
- Setting the weather or time in FS2024 — live weather in the sim does that.
- Historical or "replay" weather; multi-leg trips; saved favourites or a history of generated flights.
- Changing how a flight is planned or any calculated number once it is picked (regression must stay identical).

## Anti-goals (failure even if it "works")

- Offering a flight the aircraft can't do (out of range, runway too short, an A320 to a grass strip).
- Showing weather that isn't from a real report, or presenting a forecast as an observation.
- Making the app slower to open: the worldwide weather files load only when the panel is opened.
- Turning the METAR/TAF relay into an open proxy.
- Using Linear's name or assets; breaking the nightflight-ui house style.

## How it works

### Data

- **Worldwide observations**: `https://aviationweather.gov/data/cache/metars.cache.csv.gz` (~250 KB gz, ~5,100
  stations, refreshed every minute; columns include `station_id`, lat/lon, `wx_string`, `visibility_statute_mi`,
  `flight_category`, sky cover, `observation_time`).
- **Worldwide forecasts**: `https://aviationweather.gov/data/cache/tafs.cache.xml.gz` (~320 KB gz).
- Neither file sends CORS headers. They are reached through new data-adapter calls (rule: all UI data goes through `XD`):
  - **Packs mode**: two new **fixed** routes on the relay (`tools/wx-worker.js`) that fetch exactly those two upstream
    files — no parameters, nothing else proxied — cached at the edge for 5 minutes. The existing `ids` routes are
    unchanged.
  - **Server mode**: an equivalent endpoint in `server.py` (cached ~5 minutes in memory).
  - The browser decompresses and parses once per opening of the panel; a "Generate" within 5 minutes reuses it.
- **Runway index** (new, built with the packs by `build_packs.py`, and served by `server.py` in server mode from the
  same navdata code): one small file mapping each airport ident → longest runway length (ft), paved yes/no, lighted
  yes/no. The full per-airport runway records stay where they are (the 922 `apt/` shards); the index exists so the
  generator can screen ~49k airports without loading them.
- **Day/night** needs no data: solar elevation at the airport for the departure time.

### Definitions

- **Groups**: **GA** = every type in XPerf's own table (`apm:` — pistons, turboprops and business jets);
  **Airliner** = the OpenAP types (`oap:`). *(My call.)*
- **Snow**: present weather contains `SN` or `SG` (any intensity, incl. showers). *Builder's call whether `PL`/`FZRA`
  count as snow or rain; my call: `FZRA`/`FZDZ` → rain, `PL` → snow.*
- **Rain**: present weather contains `RA` or `DZ` (incl. `SHRA`, `TSRA`, `FZRA`) and not snow.
- **Low visibility**: flight category IFR or LIFR (visibility < 3 SM or ceiling < 1,000 ft).
- **Day**: sun above the horizon at the departure at ETD. **Night**: sun more than 6° below the horizon (properly dark).
  Twilight matches only Any. *(My call.)*
- **ETD** for a generated flight: now, rounded up to the next 10 minutes. *(My call.)*
- **Flight time estimate** for screening: great-circle distance ÷ the model's cruise speed, plus ~15 min for climb,
  descent and taxi. **Short** = 20 min – 2 h; **Long** = over 2 h, up to the aircraft's range; **Any** = 20 min to range.
  *(The 20-minute floor is my call.)* The real planned time can differ a little; the screening estimate only has to
  put the flight in the right bucket.
- **Range**: from the existing model data (airliners: fuel capacity via the normal planner; GA: published
  `cruiseRange` minus a 45-min reserve). Screening is a quick estimate; the full plan's existing range warnings remain
  the final word.
- **Runway**: candidate airports need a longest runway at least the aircraft's takeoff/landing requirement with
  margin; airliners also need a paved runway. Screen with the runway index, then confirm the shortlisted options with
  the existing runway check (`runwayPerf` in `nav.js`) for the departure and arrival.
- **Arrival weather**: for an estimated flight time up to 90 min, the arrival's current report; beyond that, the
  arrival's TAF at the estimated arrival time, labelled **forecast**. *(The 90-minute switch is my call.)* An arrival
  with an arrival-weather condition other than Any must have a report (METAR, or TAF when forecast is used).

### Generating

1. Departures: airports with a current report (observation within 90 min) that match departure weather and day/night.
   With departure weather and time both Any, any suitable airport may be a departure.
2. Arrivals: for each departure, airports in the distance band that suit the aircraft and match arrival weather.
3. Pick **5 options**, varied — not five from the same departure or the same small area. *(Count is my call.)*
4. **Closest matches**: if fewer than 5 options match everything, fill the list with near misses ranked by how many
   prompts they meet, each with a short note on what differs ("rain instead of snow", "twilight, not dark yet",
   "2 h 20 — just over short"). If even near misses are thin, say so plainly.
5. Generation runs in the browser on the already-loaded data; it should finish in well under a second after the
   weather files arrive.

### Using an option

Clicking an option fills the plan exactly as the start-screen examples do (`runExample` in `chips.js`): aircraft,
departure, arrival, ETD, navigation mode, then plan. Navigation mode: the one currently selected in the form, falling
back to Direct; *(my call — airways only exist in the US)*. Everything after that is the normal XPerf flow.

## Interface

- **Entry**: a **Random flight** button in the start-screen hero banner next to the four example flights; also a
  "Random flight" command in the Ctrl+K palette. *(Palette entry is my call.)* New flight brings the start screen and
  the button back.
- **Panel** (layout A): opens on the start screen in place of the setup form, with a way back to the normal form.
  Segmented controls for each prompt (existing `.seg` style), the aircraft dropdown filtered to the chosen group and
  defaulting to the remembered aircraft. Prompt answers are remembered (`localStorage xperf.random`). *(My call.)*
- **Option cards**: route (ICAO → ICAO) with airport names, distance, estimated time, day/night at departure, a
  departure weather tag and an arrival weather tag coloured by flight category (VFR/MVFR/IFR/LIFR tokens) with the
  short weather (e.g. `FG ¼ SM OVC002`), "forecast" when the TAF was used, and the near-miss note when relevant.
  Hover shows the raw METAR/TAF.
- **States**: loading the weather (with what's being loaded), no relay configured (explain that live weather search
  needs the site's relay or the local server), weather fetch failed (retry), results, closest matches.
- Works at phone width (existing tab-bar layout); light and dark themes; keyboard reachable.

## Constraints

- Vanilla HTML/JS, Python stdlib; no new dependencies, no build step. Bump `?v=` on changed scripts. Preserve CRLF.
- New code lives in its own file (e.g. `random.js`) with the pure parts (weather classification, solar elevation,
  screening, near-miss ranking) testable without a browser.
- Relay deploys only from an isolated folder — never `wrangler deploy` in the repo (see `tools/airac_update.py`).
- Static site: `build_site.py` must include the new file(s) and the runway index in the service-worker precache; the
  index is per AIRAC cycle like the other packs.

## Testing

- Unit tests (`node --test`): weather classification on real METAR strings; solar elevation against known
  sunrise/sunset; distance-band and range screening; runway screening; near-miss ranking and labels; option variety.
- Relay test: the two fixed routes work, anything else is still refused (extend `tests/wx-worker.test.mjs`).
- UI check in both modes (`tools/ui_check.mjs`), on recorded fixtures of the two bulk files: open panel, generate,
  pick an option, flight plans.
- `node tools/regress.mjs compare` must stay 6/6 identical.

## Left to the builder

- Exact runway margin rules per aircraft group, and how the GA takeoff/landing requirement is estimated for screening.
- Parsing details of the TAF XML; how forecast periods map to "weather at arrival time".
- Variety rule details (minimum spacing between options).
- Panel copy and microcopy, within the house style.
