import { mkdtempDisposable, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AnalysisCoverageWorkspace, StagingWorkspace } from "@kbo/persistence";
import { canonicalStringify } from "@kbo/contracts";
import { coverageSeasonFixture } from "../helpers/analysis-coverage.js";

it("persists validated summaries across restart, isolates keys and returns independent values", async () => {
  await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-coverage-"));
  const payload = coverageSeasonFixture();
  const workspace = await StagingWorkspace.open(temp.path);
  try {
    await workspace.analysisCoverage.write(payload);
  } finally {
    await workspace.close();
  }
  const restarted = await StagingWorkspace.open(temp.path);
  try {
    const loaded = await restarted.analysisCoverage.read(payload.sourceKey);
    expect(loaded).toEqual(payload);
    loaded?.games.splice(0);
    expect(await restarted.analysisCoverage.read(payload.sourceKey)).toEqual(payload);
    expect(await restarted.analysisCoverage.read("f".repeat(64))).toBeNull();
  } finally {
    await restarted.close();
  }
  await expect(restarted.analysisCoverage.write(payload)).rejects.toThrow();
});

it.each(["json", "hash", "source", "counts", "version", "order", "size"])(
  "treats %s corruption as a cache miss",
  async (damage) => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-coverage-"));
    const store = new AnalysisCoverageWorkspace(temp.path, async () => {});
    const payload = coverageSeasonFixture(),
      sourceKey = payload.sourceKey;
    await store.write(payload);
    if (damage === "source") payload.sourceKey = "f".repeat(64);
    if (damage === "counts" && payload.games[0]) payload.games[0].counts.actualPitches++;
    if (damage === "order") payload.games.push(...structuredClone(payload.games));
    const value = damage === "version" ? { ...payload, version: 2 } : payload;
    const hash = createHash("sha256").update(canonicalStringify(value)).digest("hex");
    await writeFile(
      path.join(temp.path, "analysis", "coverage", `${sourceKey}.json`),
      damage === "json"
        ? "{"
        : damage === "size"
          ? " ".repeat(16 * 1024 * 1024 + 1)
          : JSON.stringify({ payload: value, hash: damage === "hash" ? "0".repeat(64) : hash }),
    );
    expect(await store.read(sourceKey)).toBeNull();
  },
);

it("requires writer ownership and does not publish aborted preparations", async () => {
  await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-coverage-"));
  const assertWriter = vi.fn(async () => {
    throw new Error("not owner");
  });
  const store = new AnalysisCoverageWorkspace(temp.path, assertWriter);
  const payload = coverageSeasonFixture();
  await expect(store.write(payload)).rejects.toThrow("not owner");
  expect(await store.read(payload.sourceKey)).toBeNull();
  const controller = new AbortController();
  controller.abort();
  await expect(store.write(payload, controller.signal)).rejects.toThrow();
  expect(assertWriter).toHaveBeenCalledTimes(1);
  await expect(store.read("../outside")).rejects.toThrow("Invalid");
});
