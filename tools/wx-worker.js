// XPerf METAR/TAF relay (Cloudflare Worker). aviationweather.gov's data API sends no CORS headers, so a browser
// can't read it; the static site asks this Worker instead (tools/build_site.py --wx <worker URL>).
//
// Deploy, either:
//   - Cloudflare dashboard → Workers → Create → paste this file → Deploy, or
//   - npx wrangler deploy tools/wx-worker.js --name xperf-wx --compatibility-date 2026-10-01
// Optional variable ALLOW_ORIGIN = your site's origin (e.g. https://xperf.pages.dev) instead of "*".
//
// Only GET /api/data/metar and /api/data/taf are relayed, with the parameters XPerf uses and validated station
// IDs; anything else is refused, so it can't serve as an open proxy. Answers are cached for 5 minutes.
const UPSTREAM = "https://aviationweather.gov";
const ROUTES = { "/api/data/metar": ["ids", "format", "taf", "hours"], "/api/data/taf": ["ids", "format"] };
const IDS = /^[A-Za-z0-9]{3,4}(,[A-Za-z0-9]{3,4}){0,9}$/;

export default {
  async fetch(request, env = {}, ctx = {}) {
    const cors = { "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*", "Vary": "Origin" };
    const reply = (status, body) => new Response(body, { status, headers: { ...cors, "Content-Type": "text/plain" } });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    if (request.method !== "GET") return reply(405, "GET only");
    const url = new URL(request.url), keys = ROUTES[url.pathname];
    if (!keys) return reply(404, "only /api/data/metar and /api/data/taf");
    const q = new URLSearchParams();
    for (const k of keys) { const v = url.searchParams.get(k); if (v != null) q.set(k, v); }
    if (!IDS.test(q.get("ids") || "")) return reply(400, "ids: 1–10 ICAO station codes, comma-separated");

    const target = `${UPSTREAM}${url.pathname}?${q}`;
    const cache = typeof caches !== "undefined" ? caches.default : null, key = new Request(target);
    let res = cache && await cache.match(key);
    if (!res) {
      const up = await fetch(target, { headers: { "User-Agent": "XPerf METAR/TAF relay (flight simulation planner)" } });
      // a station with no report answers 204 No Content, which may not carry a body
      const body = [204, 205, 304].includes(up.status) ? null : await up.text();
      res = new Response(body, { status: up.status,
        headers: { "Content-Type": up.headers.get("Content-Type") || "application/json", "Cache-Control": "public, max-age=300" } });
      if (cache && up.ok && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
