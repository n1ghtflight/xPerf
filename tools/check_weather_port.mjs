// Node check of data.js weather() (the no-CORS path the iOS app will use) against server.py's /api/airportinfo wx.
import fs from "fs";
const BASE = "http://localhost:8771/", API = "http://localhost:8770";
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(/^https?:/.test(u) ? u : BASE + u, o);
globalThis.window = globalThis; globalThis.location = { search: "?data=packs", protocol: "http:" };
globalThis.localStorage = { getItem: () => null };
globalThis.fetchT = async (u, t) => (await fetch(u))[t]();
globalThis.get = globalThis.fetchT;
const XD = new Function(fs.readFileSync(new URL("../data.js", import.meta.url), "utf8") + "\nreturn XD;")();
const strip = w => JSON.stringify({ station: w.station, distNM: w.distNM, raw: w.metar?.rawOb, taf: w.taf, n: w.tafFcsts?.length, valid: w.tafValid });
for (const [id, lat, lon] of [["KSFO", 37.619, -122.375], ["MROC", 9.994, -84.209], ["MRJO", 9.982, -85.646], ["KO69", 38.258, -122.606]]) {
  const js = await XD.weather(id, lat, lon);
  const sv = (await (await realFetch(`${API}/api/airportinfo?ident=${id}&lat=${lat}&lon=${lon}`)).json()).wx;
  console.log(id, strip(js) === strip(sv) ? "same" : "DIFF\n  js " + strip(js) + "\n  py " + strip(sv), "| station", js.station, js.distNM, "NM", js.error || "");
}
