import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { clusterPitchPositions } from "@kbo/game-core";

const cloud = (depth: number) =>
  Array.from({ length: 20 }, () => ({ xCm: 0, zCm: 0, distanceToPlateCm: depth }));
describe("fixed-K 3D GMM", () => {
  it("separates depth-only groups, assigns every observation and preserves order", () => {
    const points = [...cloud(0), ...cloud(100)];
    const result = clusterPitchPositions(points, 2);
    expect(result).toMatchObject({
      status: "ready",
      componentCount: 2,
      clusterCount: 2,
      unassignedCount: 0,
    });
    expect(result.labels).toEqual([...Array(20).fill(1), ...Array(20).fill(2)]);
    expect(clusterPitchPositions([...points].reverse(), 2).labels.reverse()).toEqual(result.labels);
  });
  it("models tilted ellipsoids whose axis-aligned ranges overlap", () => {
    const cloud = (offset: number) => {
      let seed = 294;
      const uniform = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed + 1) / 4294967297;
      };
      const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
      return Array.from({ length: 400 }, () => {
        const x = normal() * 2;
        return { xCm: x, zCm: 1.5 * x + offset + normal() * 0.12, distanceToPlateCm: normal() };
      });
    };
    const result = clusterPitchPositions([...cloud(0), ...cloud(8)], 2);
    expect(result.status).toBe("ready");
    const dominant = (labels: (number | null)[]) =>
      Math.max(...[1, 2].map((id) => labels.filter((label) => label === id).length));
    expect(dominant(result.labels.slice(0, 400))).toBeGreaterThan(390);
    expect(dominant(result.labels.slice(400))).toBeGreaterThan(390);
    expect(result.labels[80]).not.toBe(result.labels[480]);
  });
  it("handles empty, single-point, constant and overlapping-component samples without inventing groups", () => {
    expect(clusterPitchPositions([], 0)).toMatchObject({ status: "empty", labels: [] });
    expect(clusterPitchPositions(cloud(0).slice(0, 1), 1).labels).toEqual([1]);
    expect(clusterPitchPositions(cloud(0), 3)).toMatchObject({
      status: "ready",
      componentCount: 3,
      clusterCount: 1,
    });
    expect(clusterPitchPositions([...cloud(0), ...cloud(100)], 1).labels).toEqual(
      Array(40).fill(1),
    );
  });
  it("reports non-convergence without assigning an alternative model", () => {
    expect(
      clusterPitchPositions([...cloud(0), ...cloud(100)], 2, { maxIterations: 1 }),
    ).toMatchObject({
      status: "not_converged",
      componentCount: 2,
      clusterCount: 0,
      unassignedCount: 40,
      labels: Array(40).fill(null),
    });
  });
  it("does not consume provider labels or mutate the observations", () => {
    const points = Object.freeze(
      [...cloud(0), ...cloud(100)].map((p, i) =>
        Object.freeze({ ...p, pitchType: i % 2 ? "직구" : "커터" }),
      ),
    );
    expect(clusterPitchPositions(points, 2)).toEqual(
      clusterPitchPositions(
        points.map((p) => ({ ...p, pitchType: "변경" })),
        2,
      ),
    );
  });
  it("is invariant to positive axis scale and translation", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: -1000, max: 1000 }),
        (scale, offset) => {
          const points = [...cloud(0), ...cloud(100)];
          expect(
            clusterPitchPositions(
              points.map((p) => ({
                xCm: offset,
                zCm: offset,
                distanceToPlateCm: p.distanceToPlateCm * scale + offset,
              })),
              2,
            ).labels,
          ).toEqual(clusterPitchPositions(points, 2).labels);
        },
      ),
      { numRuns: 20 },
    );
  });
  it("rejects impossible K and invalid coordinate ranges", () => {
    for (const k of [0, -1, 1.5, 21, NaN])
      expect(() => clusterPitchPositions(cloud(0), k)).toThrow();
    expect(() => clusterPitchPositions([{ xCm: NaN, zCm: 0, distanceToPlateCm: 0 }], 1)).toThrow();
    expect(() => clusterPitchPositions([...cloud(0), ...cloud(1e308)], 2)).toThrow();
  });
});
