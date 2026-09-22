// Isolated correction lookup/arithmetic benchmark; not an API response benchmark.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "calibration-search");
const input = JSON.parse(
  fs.readFileSync(path.join(directory, "performance-application-input.json"), "utf8"),
);
const profiles = new Map(Object.entries(input.profiles));
let sink = 0;
const results = [];
for (const size of [5000, 250000, 1428758]) {
  // Allocate and populate outside the timed section. Arithmetic uses real cell
  // means repeated to the requested length; it is not a raw-pitch DB benchmark.
  const rows = Array.from({ length: size }, (_, i) => input.rows[i % input.rows.length]);
  const outputX = new Float64Array(size);
  const outputZ = new Float64Array(size);
  const apply = () => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const coefficient = profiles.get(row.gameId);
      if (coefficient === undefined) throw new Error("Missing example calibration profile");
      outputX[i] = row.x - coefficient[0];
      outputZ[i] = row.z - coefficient[1];
    }
    sink += outputX[rows.length - 1] + outputZ[0];
  };
  for (let i = 0; i < 5; i++) apply();
  const times = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    apply();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  results.push({ rows: size, repetitions: times.length, medianMs: times[12], p95Ms: times[23] });
}
if (!Number.isFinite(sink)) throw new Error("Invalid benchmark output");
const result = {
  node: process.version,
  scope: input.note,
  excluded: [
    "input construction",
    "profile loading",
    "database",
    "trajectory calculation",
    "GMM",
    "response serialization",
  ],
  results,
};
fs.writeFileSync(
  path.join(directory, "performance-application.json"),
  JSON.stringify(result, null, 2),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
import process from "node:process";
