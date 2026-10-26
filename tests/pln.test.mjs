// Unit tests for the FS2024 EFB flight plan writer in pln.js (plnXML: pure, no DOM). Run: node --test tests/pln.test.mjs
// Format: docs.flightsimulator.com/msfs2024 → EFB Flight Plan XML (PLN File) Properties.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(readFileSync(new URL("../pln.js", import.meta.url), "utf8"), ctx);
const { plnXML } = ctx;

const base = {
  title: "PABT to PACX", descr: "PABT to PACX · BTT · C172", rules: "VFR", cruise: 3500,
  dep: "PABT", arr: "PACX", enroute: [{ id: "BTT", type: "VOR", region: "PA", lat: 66.905, lon: -151.536, alt: 1005 }],
};
const tags = (xml, t) => [...xml.matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map(m => m[1]);
const block = (xml, t) => (xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];

test("airports are DepartureID / DestinationID, never route waypoints", () => {
  const x = plnXML(base);
  assert.deepEqual(tags(x, "DepartureID"), ["PABT"]);
  assert.deepEqual(tags(x, "DestinationID"), ["PACX"]);
  assert.deepEqual(tags(x, "ICAOIdent"), ["BTT"]);
  assert.ok(!/<ATCWaypointType>Airport/.test(x), "an airport is in the waypoint list");
});

test("required header: title, description, rules, cruise, version 12", () => {
  const x = plnXML(base);
  assert.deepEqual(tags(x, "Title"), ["PABT to PACX"]);
  assert.deepEqual(tags(x, "FPType"), ["VFR"]);
  assert.deepEqual(tags(x, "CruisingAlt"), ["3500"]);
  assert.deepEqual(tags(x, "AppVersionMajor"), ["12"]);
  assert.ok(tags(x, "Descr").includes("PABT to PACX · BTT · C172"));
  for (const legacy of ["DepartureLLA", "DestinationLLA", "DepartureName", "RouteType", "DeparturePosition"])
    assert.ok(!x.includes(`<${legacy}>`), legacy + " is a 2020-format field");
});

test("navaid waypoints carry their region; unknown regions become user waypoints with a position", () => {
  const x = plnXML({ ...base, enroute: [base.enroute[0], { id: "MYFIX", type: "Intersection", region: null, lat: 10.5, lon: -84.25, alt: 6000 }] });
  const wps = [...x.matchAll(/<ATCWaypoint[^>]*>([\s\S]*?)<\/ATCWaypoint>/g)].map(m => m[1]);
  assert.equal(wps.length, 2);
  assert.match(wps[0], /<ATCWaypointType>VOR<\/ATCWaypointType>[\s\S]*<ICAORegion>PA<\/ICAORegion>[\s\S]*<ICAOIdent>BTT<\/ICAOIdent>/);
  assert.match(wps[1], /<ATCWaypointType>User<\/ATCWaypointType>/);
  assert.match(wps[1], /<WorldPosition>N10° 30' 0\.00",W84° 15' 0\.00",\+006000\.00<\/WorldPosition>/);
  assert.match(wps[1], /<ICAOIdent>MYFIX<\/ICAOIdent>/);
  assert.ok(!/<ICAORegion>/.test(wps[1]));
});

test("runways and procedures go in DepartureDetails / ArrivalDetails / ApproachDetails", () => {
  const x = plnXML({ ...base, rules: "IFR", depRwy: { num: "2", des: "LEFT" }, sid: "BLOKR7",
    arrRwy: { num: "12", des: "RIGHT" }, star: "AARCH2", appr: { type: "ILS", rwy: { num: "12", des: "RIGHT" } } });
  const d = block(x, "DepartureDetails"), a = block(x, "ArrivalDetails"), p = block(x, "ApproachDetails");
  assert.deepEqual([tags(d, "RunwayNumberFP"), tags(d, "RunwayDesignatorFP"), tags(d, "DepartureFP")], [["2"], ["LEFT"], ["BLOKR7"]]);
  assert.deepEqual([tags(a, "RunwayNumberFP"), tags(a, "RunwayDesignatorFP"), tags(a, "ArrivalFP")], [["12"], ["RIGHT"], ["AARCH2"]]);
  assert.deepEqual([tags(p, "ApproachTypeFP"), tags(p, "RunwayNumberFP"), tags(p, "RunwayDesignatorFP")], [["ILS"], ["12"], ["RIGHT"]]);
  // order the EFB example uses: departure details, en-route waypoints, arrival, approach
  assert.ok(x.indexOf("<DepartureDetails>") < x.indexOf("<ATCWaypoint") && x.indexOf("</ATCWaypoint>") < x.indexOf("<ArrivalDetails>")
    && x.indexOf("<ArrivalDetails>") < x.indexOf("<ApproachDetails>"));
});

test("a runway without a designator omits it; no details blocks when nothing was chosen", () => {
  const x = plnXML({ ...base, depRwy: { num: "1", des: "NONE" } });
  assert.deepEqual(tags(block(x, "DepartureDetails"), "RunwayNumberFP"), ["1"]);
  assert.ok(!/RunwayDesignatorFP/.test(x));
  assert.ok(!/ArrivalDetails|ApproachDetails/.test(x));
  assert.ok(!/<DepartureFP>|<ArrivalFP>|<ApproachTypeFP>/.test(plnXML(base)));
});

test("direct flight: no waypoints at all is valid", () => {
  const x = plnXML({ ...base, enroute: [] });
  assert.ok(!/<ATCWaypoint/.test(x));
  assert.deepEqual(tags(x, "DepartureID"), ["PABT"]);
});

test("text is XML-escaped", () => {
  const x = plnXML({ ...base, descr: `A & B <"q">` });
  assert.ok(x.includes("A &amp; B &lt;&quot;q&quot;&gt;"));
});
