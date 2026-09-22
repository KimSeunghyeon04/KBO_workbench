import type { PitchReferenceDistribution } from "@kbo/contracts";

type Vector = readonly [number, number, number];
export function createReferenceContours(distribution: PitchReferenceDistribution) {
  const c = distribution.center,
    l = distribution.transform;
  const transform = (x: number, y: number, z: number, radius: number): Vector => [
    c.xCm + radius * l.xx * x,
    c.distanceToPlateCm + radius * (l.yx * x + l.yy * y),
    c.zCm + radius * (l.zx * x + l.zy * y + l.zz * z),
  ];
  const contours = (["central90", "central50"] as const).map((key) => {
    const radius = distribution[key].radius;
    const lines: Vector[][] = [];
    for (let latitude = -2; latitude <= 2; latitude++) {
      const phi = (latitude * Math.PI) / 6;
      lines.push(
        Array.from({ length: 65 }, (_, i) => {
          const theta = (i * Math.PI) / 32;
          return transform(
            Math.cos(phi) * Math.cos(theta),
            Math.cos(phi) * Math.sin(theta),
            Math.sin(phi),
            radius,
          );
        }),
      );
    }
    for (let longitude = 0; longitude < 6; longitude++) {
      const theta = (longitude * Math.PI) / 6;
      lines.push(
        Array.from({ length: 65 }, (_, i) => {
          const phi = (i * Math.PI) / 32;
          return transform(
            Math.cos(phi) * Math.cos(theta),
            Math.cos(phi) * Math.sin(theta),
            Math.sin(phi),
            radius,
          );
        }),
      );
    }
    return { key, lines };
  });
  const radius = distribution.central90.radius;
  const extent = {
    xCm: l.xx * radius,
    distanceToPlateCm: Math.hypot(l.yx, l.yy) * radius,
    zCm: Math.hypot(l.zx, l.zy, l.zz) * radius,
  };
  const bounds = [-1, 1].map((sign) => ({
    xCm: c.xCm + sign * extent.xCm,
    distanceToPlateCm: c.distanceToPlateCm + sign * extent.distanceToPlateCm,
    zCm: c.zCm + sign * extent.zCm,
  }));
  return { contours, bounds };
}
