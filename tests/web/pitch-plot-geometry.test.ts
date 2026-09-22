import { expect, it } from "vitest";
import { createPitchPlotGeometry } from "../../apps/web/src/analysis/pitch-plot-geometry.js";

it("projects depth under rotation while frontal X/Z positions coincide", () => {
  const points = [
    { xCm: 0, zCm: 0, distanceToPlateCm: 0 },
    { xCm: 0, zCm: 0, distanceToPlateCm: 100 },
  ];
  const view = { yaw: 0, elevation: 0, zoom: 1, equalScale: true };
  const front = createPitchPlotGeometry(points, 736, 520, view);
  expect(front.project([0, 0, 0]).x).toBe(front.project([0, 100, 0]).x);
  expect(front.project([0, 0, 0]).y).toBe(front.project([0, 100, 0]).y);
  const rotated = createPitchPlotGeometry(points, 736, 520, { ...view, yaw: 45 });
  expect(rotated.project([0, 0, 0]).x).not.toBe(rotated.project([0, 100, 0]).x);
  expect(rotated.edges).toHaveLength(12);
});
it("keeps equal lengths equal in the physical frontal view and fits a narrow viewport", () => {
  const view = { yaw: 0, elevation: 0, zoom: 1, equalScale: true };
  const plot = createPitchPlotGeometry(
    [{ xCm: 20, zCm: 30, distanceToPlateCm: 400 }],
    280,
    390,
    view,
  );
  const origin = plot.project([0, 0, 0]);
  expect(plot.project([10, 0, 0]).x - origin.x).toBeCloseTo(origin.y - plot.project([0, 0, 10]).y);
  for (const edge of plot.edges)
    for (const p of edge) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(280);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(390);
    }
});
