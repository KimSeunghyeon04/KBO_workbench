import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PitchReferenceDistributionSchema, type PitchAnalysisPoint } from "@kbo/contracts";
import {
  classifyPitchReference,
  fitPitchReferenceDistribution,
  pitchReferenceDistance,
  summarizePitchExpectation,
} from "@kbo/game-core";

const referencePoints = Array.from({ length: 101 }, (_, i) => ({
  xCm: (i - 50) * 0.3,
  distanceToPlateCm: (i - 50) * 2 + Math.sin(i) * 12,
  zCm: (i - 50) * 0.6 + Math.cos(i * 3) * 8,
}));
function point(i: number, overrides: Partial<PitchAnalysisPoint> = {}): PitchAnalysisPoint {
  return {
    gameId: "g1",
    revision: 1,
    pitchId: `p${i}`,
    trackingId: `t${i}`,
    gameDate: "2024-06-01",
    stadium: null,
    calibrationStatus: "insufficient_data",
    calibrationXcm: null,
    calibrationZcm: null,
    pitchType: "직구",
    clusterId: 1,
    speedKph: 145,
    xCm: 0,
    zCm: 0,
    distanceToPlateCm: 0,
    arrivalMs: 400,
    timingDifferenceMs: 0,
    extrapolated: false,
    swing: false,
    whiff: false,
    referenceBand: null,
    ...overrides,
  };
}
describe("season four-seam expectation", () => {
  it("calibrates nested empirical coverage on tilted 3D data, independent of input order", () => {
    const distribution = fitPitchReferenceDistribution(referencePoints);
    if (distribution === null) throw new Error("Missing reference");
    expect(Value.Check(PitchReferenceDistributionSchema, distribution)).toBe(true);
    expect(distribution).toEqual(fitPitchReferenceDistribution([...referencePoints].reverse()));
    expect(distribution.transform.yx).toBeGreaterThan(0);
    const bands = referencePoints.map((p) => classifyPitchReference(p, distribution));
    expect(bands.filter((b) => b === "core50")).toHaveLength(51);
    expect(bands.filter((b) => b !== "outside90")).toHaveLength(91);
    expect(distribution.central90.includedCount).toBe(91);
    expect(
      classifyPitchReference({ ...distribution.center, distanceToPlateCm: 10000 }, distribution),
    ).toBe("outside90");
    expect(classifyPitchReference(distribution.center, distribution)).toBe("core50");
  });
  it("handles small samples, constant axes and ties without pretending exactly 50/90 percent", () => {
    expect(fitPitchReferenceDistribution([])).toBeNull();
    expect(fitPitchReferenceDistribution(referencePoints.slice(0, 3))).toBeNull();
    const identical = fitPitchReferenceDistribution(Array.from({ length: 4 }, () => point(0)));
    expect(identical?.central50).toEqual({ radius: 0, includedCount: 4 });
    expect(identical?.central90).toEqual({ radius: 0, includedCount: 4 });
    expect(classifyPitchReference(point(1, { zCm: 1 }), identical)).toBe("outside90");
    const line = fitPitchReferenceDistribution(
      referencePoints.map((p) => ({ ...p, zCm: 0, xCm: 0 })),
    );
    expect(line).not.toBeNull();
    expect(Value.Check(PitchReferenceDistributionSchema, line)).toBe(true);
    expect(() =>
      fitPitchReferenceDistribution([
        ...referencePoints,
        { xCm: NaN, zCm: 0, distanceToPlateCm: 0 },
      ]),
    ).toThrow("Non-finite");
  });
  it("is translation invariant and keeps depth in the reference distance", () => {
    const d = fitPitchReferenceDistribution(referencePoints);
    const shifted = fitPitchReferenceDistribution(
      referencePoints.map((p) => ({ ...p, xCm: p.xCm + 100, zCm: p.zCm - 20 })),
    );
    if (d === null || shifted === null) throw new Error("Missing reference");
    expect(pitchReferenceDistance(point(0), d)).toBeCloseTo(
      pitchReferenceDistance(point(0, { xCm: 100, zCm: -20 }), shifted),
      10,
    );
    expect(pitchReferenceDistance(point(0, { distanceToPlateCm: 500 }), d)).toBeGreaterThan(
      pitchReferenceDistance(point(0), d),
    );
  });
  it("uses swing denominators, preserves no-swing nulls, and separates groups and empty bands", () => {
    const d = fitPitchReferenceDistribution(referencePoints);
    const input = [
      point(0, { swing: true, whiff: true, xCm: -0.1, timingDifferenceMs: -10 }),
      point(1, { swing: true, xCm: 0.1, timingDifferenceMs: 10 }),
      point(2),
      point(3, { pitchType: null, clusterId: null, xCm: 1000 }),
    ].map((p) => ({ ...p, referenceBand: classifyPitchReference(p, d) }));
    const result = summarizePitchExpectation(input, d);
    expect(result).toEqual(summarizePitchExpectation([...input].reverse(), d));
    expect(result.providerGroups.find((g) => g.pitchType === "직구")).toMatchObject({
      count: 3,
      meanXCm: 0,
      meanTimingMs: 0,
      swings: 2,
      whiffs: 1,
      whiffRate: 0.5,
    });
    expect(result.providerGroups.find((g) => g.pitchType === null)).toMatchObject({
      count: 1,
      outside90Count: 1,
      swings: 0,
      whiffRate: null,
    });
    expect(result.bands.reduce((sum, g) => sum + g.count, 0)).toBe(4);
    expect(result.bands.find((g) => g.band === "shell90")).toMatchObject({
      count: 0,
      meanXCm: null,
      whiffRate: null,
    });
    const noReference = summarizePitchExpectation([point(0)], null);
    expect(noReference.bands).toEqual([]);
    expect(noReference.clusterGroups[0]).toMatchObject({ outside90Count: null, sdXCm: 0 });
    expect(() => summarizePitchExpectation([point(0, { whiff: true })], null)).toThrow(
      "Inconsistent",
    );
    expect(() => summarizePitchExpectation([point(0)], d)).toThrow("Inconsistent");
  });
});
