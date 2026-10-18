// Unit tests for the METAR/TAF relay Worker (tools/wx-worker.js). Run: node --test tests/wx-worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const worker = (await import(new URL("../tools/wx-worker.js", import.meta.url))).default;
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init });
  return new Response(JSON.stringify([{ icaoId: "KPAO", rawOb: "KPAO 171853Z 31008KT 10SM CLR 21/09 A3002" }]), { status: 200, headers: { "Content-Type": "application/json" } }); };
const ask = (path, init) => worker.fetch(new Request("https://xperf-wx.example.workers.dev" + path, init), {}, { waitUntil() {} });

test("relays a METAR request with only the parameters XPerf uses, with CORS", async () => {
  calls.length = 0;
  const res = await ask("/api/data/metar?ids=KPAO&format=json&taf=true&hours=2&evil=1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await res.json())[0].icaoId, "KPAO");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://aviationweather.gov/api/data/metar?ids=KPAO&format=json&taf=true&hours=2");
  assert.match(calls[0].init.headers["User-Agent"], /XPerf/);
});

test("relays a TAF request", async () => {
  calls.length = 0;
  const res = await ask("/api/data/taf?ids=EGLL&format=json");
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "https://aviationweather.gov/api/data/taf?ids=EGLL&format=json");
});

test("refuses anything that is not a METAR or TAF lookup", async () => {
  calls.length = 0;
  assert.equal((await ask("/api/data/pirep?ids=KPAO")).status, 404);
  assert.equal((await ask("/https://example.com/")).status, 404);
  assert.equal((await ask("/api/data/metar?ids=KPAO;DROP")).status, 400);
  assert.equal((await ask("/api/data/metar")).status, 400);
  assert.equal((await ask("/api/data/metar?ids=KPAO", { method: "POST", body: "x" })).status, 405);
  assert.equal(calls.length, 0, "nothing may reach the upstream");
});

test("answers the CORS preflight", async () => {
  const res = await ask("/api/data/metar?ids=KPAO", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
});

test("ALLOW_ORIGIN limits the CORS origin", async () => {
  const res = await worker.fetch(new Request("https://w.example/api/data/metar?ids=KPAO"), { ALLOW_ORIGIN: "https://xperf.example" }, { waitUntil() {} });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://xperf.example");
});

test("a station with no report (upstream 204, empty) passes through as 204", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const res = await ask("/api/data/metar?ids=CYXX&format=json&taf=true&hours=2");
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(await res.text(), "");
  } finally { globalThis.fetch = real; }
});
