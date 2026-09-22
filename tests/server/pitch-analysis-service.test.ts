import { describe, expect, it, vi } from "vitest";
import { clusterPitchPositions } from "@kbo/game-core";
import type { PitchAnalysisSample, PitchClusterInput, PitchClusterResult } from "@kbo/contracts";
import { PitchAnalysisService } from "../../apps/server/src/pitch-analysis-service.js";
import { calibrationSummary } from "../helpers/pitch-calibration.js";

function sample(
  types: (string | null)[] = ["직구", "직구", "슬라이더", "투심"],
): PitchAnalysisSample {
  return {
    modelVersion: 2,
    calibration: calibrationSummary(types.length),
    season: 2024,
    pitcherId: "p1",
    sourceHash: "a".repeat(64),
    referenceSourceHash: "a".repeat(64),
    profile: { groups: [], months: [] },
    baseline: null,
    referenceDistribution: null,
    actualPitchCount: types.length,
    missingTrackingCount: 0,
    invalidTrackingCount: 0,
    points: types.map((pitchType, i) => ({
      gameId: "g1",
      revision: 1,
      pitchId: `p${i}`,
      trackingId: `t${i}`,
      gameDate: "2024-06-01",
      stadium: null,
      calibrationStatus: "insufficient_data",
      calibrationXcm: null,
      calibrationZcm: null,
      pitchType,
      speedKph: null,
      xCm: i * 2,
      zCm: -i * 2,
      distanceToPlateCm: i * 100,
      arrivalMs: 400,
      timingDifferenceMs: i * 20,
      extrapolated: false,
      swing: true,
      whiff: false,
      referenceBand: null,
    })),
  };
}
const runner = () => ({
  fit: vi.fn(async (input: PitchClusterInput) =>
    clusterPitchPositions(input.points, input.componentCount),
  ),
  close: vi.fn(async () => {}),
});

describe("GMM analysis composition and cache", () => {
  it("invalidates geometry when the calibration profile changes", async () => {
    const current = sample();
    const engine = runner();
    const service = new PitchAnalysisService({ analyze: async () => current }, engine);
    await service.analyze(2024, "p1");
    current.calibration.profileHash = "d".repeat(64);
    await service.analyze(2024, "p1");
    expect(engine.fit).toHaveBeenCalledTimes(2);
    await service.close();
  });
  it("assembles outcome summaries from all valid pitches while reusing cached geometry", async () => {
    const current = sample();
    const engine = runner();
    const service = new PitchAnalysisService({ analyze: async () => current }, engine);
    current.points = current.points.map((p, i) => ({ ...p, swing: i < 2, whiff: i === 0 }));
    const result = await service.analyze(2024, "p1");
    expect(result.expectation.providerGroups.find((g) => g.pitchType === "직구")).toMatchObject({
      count: 2,
      swings: 2,
      whiffs: 1,
      whiffRate: 0.5,
      meanXCm: 1,
      meanTimingMs: 10,
      outside90Count: null,
    });
    expect(
      result.expectation.providerGroups.find((g) => g.pitchType === "투심")?.whiffRate,
    ).toBeNull();
    expect((await service.analyze(2024, "p1")).expectation).toEqual(result.expectation);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it("counts rare named types, includes unknown pitches, supports overrides and validates ranges", async () => {
    const current = sample(["직구", "직구", "슬라이더", "투심", null]);
    const engine = runner(),
      service = new PitchAnalysisService({ analyze: async () => current }, engine);
    expect((await service.analyze(2024, "p1")).clustering).toMatchObject({
      defaultClusterCount: 3,
      componentCount: 3,
      maxClusterCount: 5,
      status: "ready",
    });
    const override = await service.analyze(2024, "p1", 2);
    expect(override.points).toHaveLength(5);
    expect(override.clustering.componentCount).toBe(2);
    expect(
      engine.fit.mock.calls.every(([input]) => input.points.every((p) => !("pitchType" in p))),
    ).toBe(true);
    for (const k of [0, -1, 1.5, 6, NaN])
      await expect(service.analyze(2024, "p1", k)).rejects.toThrow("군집 수");
    await service.close();
  });
  it("handles unknown-only and empty samples", async () => {
    const engine = runner();
    const unknown = new PitchAnalysisService({ analyze: async () => sample([null, null]) }, engine);
    expect((await unknown.analyze(2024, "p1")).clustering).toMatchObject({
      defaultClusterCount: 1,
      componentCount: 1,
    });
    const empty = new PitchAnalysisService({ analyze: async () => sample([]) }, engine);
    expect((await empty.analyze(2024, "p1")).clustering).toMatchObject({
      defaultClusterCount: 0,
      maxClusterCount: 0,
      status: "empty",
    });
    expect(engine.fit).toHaveBeenCalledTimes(1);
    await unknown.close();
    await empty.close();
  });
  it("shares pending work and keys cached fits by source, target and K, with LRU eviction", async () => {
    let current = sample();
    const engine = runner(),
      service = new PitchAnalysisService(
        { analyze: async (season, pitcherId) => ({ ...current, season, pitcherId }) },
        engine,
      );
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => service.analyze(2024, "p1")),
    );
    expect(responses.every((r) => JSON.stringify(r) === JSON.stringify(responses[0]))).toBe(true);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    await service.analyze(2024, "p1", 3);
    expect(engine.fit).toHaveBeenCalledTimes(1);
    await service.analyze(2024, "p1", 2);
    await service.analyze(2025, "p1");
    await service.analyze(2024, "p2");
    expect(engine.fit).toHaveBeenCalledTimes(4);
    for (let i = 1; i <= 33; i++) {
      current = { ...current, sourceHash: i.toString(16).padStart(64, "0") };
      await service.analyze(2024, "p1");
    }
    current = sample();
    await service.analyze(2024, "p1");
    expect(engine.fit).toHaveBeenCalledTimes(38);
    await service.close();
    expect(engine.close).toHaveBeenCalledTimes(1);
    await expect(service.analyze(2024, "p1")).rejects.toThrow("closed");
  });
  it("does not cache worker failure and exposes non-convergence without fallback", async () => {
    const engine = runner();
    engine.fit.mockRejectedValueOnce(new Error("worker failed"));
    const service = new PitchAnalysisService({ analyze: async () => sample() }, engine);
    await expect(service.analyze(2024, "p1")).rejects.toThrow("worker failed");
    engine.fit.mockResolvedValueOnce({
      status: "not_converged",
      componentCount: 3,
      clusterCount: 0,
      unassignedCount: 4,
      iterations: 0,
      labels: [null, null, null, null],
    });
    const response = await service.analyze(2024, "p1");
    expect(response.clustering.status).toBe("not_converged");
    expect(response.points.every((p) => p.clusterId === null)).toBe(true);
    await service.close();
  });
  it("rejects worker results with inconsistent labels and sample shape", async () => {
    const engine = runner(),
      service = new PitchAnalysisService({ analyze: async () => sample() }, engine);
    const invalid: PitchClusterResult = {
      status: "ready",
      componentCount: 3,
      clusterCount: 1,
      unassignedCount: 0,
      iterations: 2,
      labels: [1],
    };
    engine.fit.mockResolvedValueOnce(invalid);
    await expect(service.analyze(2024, "p1")).rejects.toThrow("Inconsistent");
    expect((await service.analyze(2024, "p1")).points).toHaveLength(4);
    await service.close();
  });
});
