import { writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import { expect, it } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { trainPitchQuality, summarizePitchQuality, trainParkEnvironment } from "@kbo/game-core";
import { qualityRows, qualityProfiles } from "../helpers/pitch-quality.js";
import { parkEnvironmentRows } from "../helpers/park-environment.js";
it("measures offline training and player inference separately on fixed synthetic fixtures", async () => {
  const rows = qualityRows(),
    parks = [2020, 2021, 2022, 2023, 2024, 2025].flatMap((y) => parkEnvironmentRows(y, 240)),
    hash = "a".repeat(64),
    records: unknown[] = [];
  let maxRss = process.memoryUsage().rss;
  function measure(label: string, inputRows: number, work: () => unknown) {
    const times: number[] = [],
      serialization: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      const start = performance.now(),
        value = work();
      times.push(performance.now() - start);
      const serializedAt = performance.now(),
        json = JSON.stringify(value);
      serialization.push(performance.now() - serializedAt);
      bytes = Buffer.byteLength(json);
      maxRss = Math.max(maxRss, process.memoryUsage().rss);
    }
    const summary = (values: number[]) => {
      const sorted = values.slice(1).sort((a, b) => a - b);
      return {
        firstMs: values[0],
        warmMeanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        warmP95Ms: sorted[Math.floor(sorted.length * 0.95)],
      };
    };
    records.push({
      label,
      inputRows,
      repetitions: 30,
      compute: summary(times),
      serialization: summary(serialization),
      outputBytes: bytes,
    });
  }
  measure("quality-training", rows.length, () => trainPitchQuality(rows, qualityProfiles(), hash));
  const model = trainPitchQuality(rows, qualityProfiles(), hash),
    season = rows.filter((r) => r.season === 2025),
    player = Array.from({ length: 5000 }, (_, i) => season[i % season.length]).filter(
      (r) => r !== undefined,
    ),
    scope = resolveAnalysisScope({ season: 2025, competition: "regular" });
  measure("quality-player", player.length, () =>
    summarizePitchQuality(player, scope, "p", hash, model, hash),
  );
  measure("park-training", parks.length, () => trainParkEnvironment(parks, hash));
  expect(model.targets.some((m) => m.adopted)).toBe(true);
  await mkdir("analysis", { recursive: true });
  await writeFile(
    "analysis/analytics-performance.json",
    JSON.stringify(
      {
        node: process.version,
        cpu: os.cpus()[0]?.model,
        platform: process.platform,
        fixture:
          "synthetic; performance only; excludes database, IPC and disk I/O; first is process-warm/JIT-cold",
        maxSampledRssBytes: maxRss,
        records,
      },
      null,
      2,
    ) + "\n",
  );
});
