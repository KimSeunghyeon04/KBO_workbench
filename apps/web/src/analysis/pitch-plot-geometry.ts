import type { PitchAnalysisPoint } from "@kbo/contracts";

type Vector = readonly [number, number, number];
interface Position {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}
export interface PlotView {
  readonly yaw: number;
  readonly elevation: number;
  readonly zoom: number;
  readonly equalScale: boolean;
}

export function createPitchPlotGeometry(
  points: readonly Pick<PitchAnalysisPoint, "xCm" | "zCm" | "distanceToPlateCm">[],
  width: number,
  height: number,
  view: PlotView,
) {
  const axes = ["xCm", "distanceToPlateCm", "zCm"] as const;
  const ranges = axes.map((key) => {
    let lo = -5,
      hi = 5;
    for (const point of points) {
      lo = Math.min(lo, point[key]);
      hi = Math.max(hi, point[key]);
    }
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad, center: (lo + hi) / 2, span: (hi - lo) * 1.12 };
  });
  const maxSpan = Math.max(...ranges.map((r) => r.span));
  const yaw = (view.yaw * Math.PI) / 180,
    elevation = (view.elevation * Math.PI) / 180;
  function rotate(v: Vector): Vector {
    const normalized = v.map((value, k) => {
      const r = ranges[k];
      return r === undefined ? 0 : (value - r.center) / (view.equalScale ? maxSpan : r.span);
    });
    const [x = 0, y = 0, z = 0] = normalized;
    const horizontal = x * Math.cos(yaw) + y * Math.sin(yaw);
    const depth = y * Math.cos(yaw) - x * Math.sin(yaw);
    return [
      horizontal,
      z * Math.cos(elevation) - depth * Math.sin(elevation),
      depth * Math.cos(elevation) + z * Math.sin(elevation),
    ];
  }
  const corners: Vector[] = [];
  for (let i = 0; i < 8; i++)
    corners.push([
      ranges[0]?.[i & 1 ? "hi" : "lo"] ?? 0,
      ranges[1]?.[i & 2 ? "hi" : "lo"] ?? 0,
      ranges[2]?.[i & 4 ? "hi" : "lo"] ?? 0,
    ]);
  const rotated = corners.map(rotate);
  const xExtent = Math.max(...rotated.map((p) => Math.abs(p[0]))) * 2;
  const zExtent = Math.max(...rotated.map((p) => Math.abs(p[1]))) * 2;
  const scale =
    Math.min((width - 100) / Math.max(0.01, xExtent), (height - 100) / Math.max(0.01, zExtent)) *
    view.zoom;
  function project(v: Vector): Position {
    const p = rotate(v);
    return { x: width / 2 + p[0] * scale, y: height / 2 - p[1] * scale, depth: p[2] };
  }
  const edges: [Position, Position][] = [];
  corners.forEach((v, i) => {
    for (const bit of [1, 2, 4]) {
      const other = corners[i ^ bit];
      if (other !== undefined && i < (i ^ bit)) edges.push([project(v), project(other)]);
    }
  });
  const labels: { x: number; y: number; text: string }[] = [];
  const base: [number, number, number] = [
    ranges[0]?.lo ?? 0,
    ranges[1]?.lo ?? 0,
    ranges[2]?.lo ?? 0,
  ];
  const names = ["X (cm)", "Y (cm)", "Z (cm)"];
  ranges.forEach((range, axis) => {
    const end: [number, number, number] = [...base];
    end[axis] = range.hi;
    const a = project(base),
      b = project(end);
    let nx = b.y - a.y,
      ny = a.x - b.x;
    const length = Math.hypot(nx, ny);
    if (length < 20) return;
    nx /= length;
    ny /= length;
    const mx = (a.x + b.x) / 2,
      my = (a.y + b.y) / 2;
    if (nx * (mx - width / 2) + ny * (my - height / 2) < 0) {
      nx = -nx;
      ny = -ny;
    }
    labels.unshift({ x: mx + nx * 35, y: my + ny * 35, text: names[axis] ?? "" });
    const rough = range.span / (width < 500 ? 2 : 4);
    const power = 10 ** Math.floor(Math.log10(rough));
    const tick = ([1, 2, 5, 10].find((n) => n * power >= rough) ?? 10) * power;
    for (let value = Math.ceil(range.lo / tick) * tick; value <= range.hi; value += tick) {
      const v: [number, number, number] = [...base];
      v[axis] = value;
      const p = project(v);
      labels.push({
        x: p.x + nx * 14,
        y: p.y + ny * 14,
        text: String(Number(value.toPrecision(6))),
      });
    }
  });
  return { project, edges, labels };
}
