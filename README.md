# XPerf

Flight performance and route planner for **Microsoft Flight Simulator 2024**. Pick an aircraft, a departure and an
arrival; XPerf works out the cruise level, climb and descent, fuel, non-GPS navigation (VOR/NDB, US airways, FAA
published routes or your own route), departure and arrival briefings with live weather, airliner takeoff and landing
numbers, and exports a `.PLN` for the FS2024 world map.

**Use it in your browser: <https://xperf.n1ghtflight.workers.dev>** — free, no account, works offline once loaded and
can be installed as an app.

> For flight simulation only — not for real-world navigation or flight planning.

## Feedback

Found a bug, or a number that looks wrong? [Open an issue](https://github.com/n1ghtflight/xPerf/issues) with the
aircraft, the airports and what you expected. A screenshot helps.

## Run it locally

Python 3.14, standard library only:

```
python server.py        # http://localhost:8765, live data
```

The first run downloads about 40 MB of public FAA and OurAirports data into `cache/`.

## Data

Free and public sources only: OurAirports, FAA NASR and d-TPP, OpenAP (TU Delft), Open-Meteo, aviationweather.gov,
OpenStreetMap and OpenTopoMap. Full credits are in the app under Settings › About. XPerf is a hobby project, not
affiliated with Microsoft, Asobo Studio or any data provider.

## License

XPerf's code is under the [MIT License](LICENSE). Leaflet (`vendor/`) keeps its own BSD-2-Clause license, and data
downloaded at run time keeps its providers' terms.
