// Fit the takeoff field-length tuning in data/to_tune.json to its chart points and print the residuals.
//   node tools/fit_to_tune.mjs      (aircraft data: tests/fixtures/to_aircraft.json, the OpenAP snapshot)
// factor = geometric mean of chart/model; if any residual is still above 5 %, also an altitude term (least squares
// on chart/model = factor × (1 + altK × pressure altitude / 1000 ft)).
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ctx = vm.createContext({}); vm.runInContext(read("toperf.js"), ctx); const T = ctx.TOPerf;
const REF = JSON.parse(read("data/to_ref.json")).types, FIX = JSON.parse(read("tests/fixtures/to_aircraft.json"));
const file = JSON.parse(read("data/to_tune.json"));

for (const [code, t] of Object.entries(file.types)) {
  const raw = T.tuningReport(T.acFromModel(FIX[code], REF[code], null), t.points);
  const ratio = raw.map(r => r.chartFt / r.modelFt), pa = t.points.map(p => p.paFt / 1000);
  let factor = Math.exp(ratio.reduce((s, r) => s + Math.log(r), 0) / ratio.length), altK = 0;
  const worst = (f, k) => Math.max(...raw.map((r, i) => Math.abs(r.modelFt * f * (1 + k * pa[i]) / r.chartFt - 1) * 100));
  if (worst(factor, 0) > 5) {
    const n = ratio.length, mx = pa.reduce((a, b) => a + b) / n, my = ratio.reduce((a, b) => a + b) / n;
    const b = pa.reduce((s, x, i) => s + (x - mx) * (ratio[i] - my), 0) / pa.reduce((s, x) => s + (x - mx) ** 2, 0);
    factor = my - b * mx; altK = b / factor;
  }
  t.factor = +factor.toFixed(4); t.altK = +altK.toFixed(5); t.residualMaxPct = +worst(t.factor, t.altK).toFixed(1);
  console.log(`${code}: factor ${t.factor}, altK ${t.altK}/1000 ft, worst residual ${t.residualMaxPct} %`);
  const tuned = T.tuningReport(T.acFromModel(FIX[code], REF[code], t), t.points);
  for (const r of tuned) console.log(`  ${String(r.point.massKg).padStart(6)} kg ${String(r.point.paFt).padStart(5)} ft ISA+${r.point.isaDev}: ` +
    `chart ${r.chartFt} ft, untuned ${Math.round(raw[tuned.indexOf(r)].modelFt)}, tuned ${Math.round(r.modelFt)} (${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)} %)`);
}
writeFileSync(new URL("../data/to_tune.json", import.meta.url), (JSON.stringify(file, null, 1) + "\n").replace(/\n/g, "\r\n"));
