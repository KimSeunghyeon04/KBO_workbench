import { expect, it } from "vitest";
import { fitPitchReferenceDistribution, pitchReferenceDistance } from "@kbo/game-core";
import { createReferenceContours } from "../../apps/web/src/analysis/pitch-reference-geometry.js";

it("renders calibrated 3D boundaries in the same X/Y/Z coordinate space, with complete bounds", () => {
  const d = fitPitchReferenceDistribution(
    Array.from({ length: 40 }, (_, i) => ({
      xCm: i,
      distanceToPlateCm: i * 5 + Math.sin(i),
      zCm: i * 2 + Math.cos(i),
    })),
  );
  if (d === null) throw new Error("Missing reference");
  const mesh = createReferenceContours(d);
  const [lo, hi] = mesh.bounds;
  if (lo === undefined || hi === undefined) throw new Error("Missing bounds");
  for (const contour of mesh.contours)
    for (const line of contour.lines)
      for (const [x, y, z] of line) {
        expect(pitchReferenceDistance({ xCm: x, distanceToPlateCm: y, zCm: z }, d)).toBeCloseTo(
          d[contour.key].radius,
          8,
        );
        expect(x).toBeGreaterThanOrEqual(lo.xCm - 1e-9);
        expect(x).toBeLessThanOrEqual(hi.xCm + 1e-9);
        expect(y).toBeGreaterThanOrEqual(lo.distanceToPlateCm - 1e-9);
        expect(y).toBeLessThanOrEqual(hi.distanceToPlateCm + 1e-9);
        expect(z).toBeGreaterThanOrEqual(lo.zCm - 1e-9);
        expect(z).toBeLessThanOrEqual(hi.zCm + 1e-9);
      }
});
