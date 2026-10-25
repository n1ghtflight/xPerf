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

// the two worldwide cache files are gzip bytes (upstream says application/octet-stream), relayed untouched
const withGzip = async fn => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init });
    return new Response(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), { status: 200, headers: { "Content-Type": "application/octet-stream" } }); };
  try { await fn(); } finally { globalThis.fetch = real; }
};

test("relays the worldwide METAR file byte for byte", () => withGzip(async () => {
  calls.length = 0;
  const res = await ask("/data/cache/metars.cache.csv.gz?x=1");
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "https://aviationweather.gov/data/cache/metars.cache.csv.gz");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x1f, 0x8b, 1, 2, 3]);
  assert.equal(res.headers.get("Content-Type"), "application/gzip");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
}));

test("relays the worldwide TAF file", () => withGzip(async () => {
  calls.length = 0;
  const res = await ask("/data/cache/tafs.cache.xml.gz");
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "https://aviationweather.gov/data/cache/tafs.cache.xml.gz");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x1f, 0x8b, 1, 2, 3]);
  assert.equal(res.headers.get("Content-Type"), "application/gzip");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
}));

test("still refuses other cache files", async () => {
  calls.length = 0;
  assert.equal((await ask("/data/cache/pireps.cache.csv.gz")).status, 404);
  assert.equal(calls.length, 0);
});

// aviationweather.gov sometimes answers 200 with an empty or non-gzip body; that must not be relayed or edge-cached
const withBody = async (body, fn) => {
  const real = globalThis.fetch, puts = [], realCaches = globalThis.caches;
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  globalThis.caches = { default: { match: async () => undefined, put: async (k, r) => { puts.push(k.url); } } };
  try { await fn(puts); } finally { globalThis.fetch = real; globalThis.caches = realCaches; }
};
const askAndWait = async (path) => { const waits = [];
  const res = await worker.fetch(new Request("https://xperf-wx.example.workers.dev" + path), {}, { waitUntil: p => waits.push(p) });
  await Promise.all(waits); return res; };

test("refuses to relay an empty worldwide file", () => withBody("", async puts => {
  const res = await askAndWait("/data/cache/metars.cache.csv.gz");
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(puts, [], "an empty answer must not enter the edge cache");
}));

test("refuses a non-gzip worldwide file", () => withBody("<html>maintenance</html>", async puts => {
  const res = await askAndWait("/data/cache/tafs.cache.xml.gz");
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(puts, []);
}));

test("a good worldwide file is still edge-cached", () => withBody(new Uint8Array([0x1f, 0x8b, 8, 0]), async puts => {
  const res = await askAndWait("/data/cache/metars.cache.csv.gz");
  assert.equal(res.status, 200);
  assert.deepEqual(puts, ["https://aviationweather.gov/data/cache/metars.cache.csv.gz"]);
}));
