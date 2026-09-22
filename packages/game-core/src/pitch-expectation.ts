import type {
  PitchAnalysisPoint,
  PitchExpectation,
  PitchExpectationGroup,
  PitchReferenceBand,
  PitchReferenceDistribution,
} from "@kbo/contracts";

type Position = Pick<PitchAnalysisPoint, "xCm" | "distanceToPlateCm" | "zCm">;
const regularizationCm2 = 0.0001;
const inside = (distance: number, radius: number): boolean =>
  distance <= radius + 1e-10 * Math.max(1, radius);
const compare = (a: Position, b: Position): number =>
  a.xCm - b.xCm || a.distanceToPlateCm - b.distanceToPlateCm || a.zCm - b.zCm;

export function pitchReferenceDistance(
  point: Position,
  distribution: PitchReferenceDistribution,
): number {
  const c = distribution.center,
    l = distribution.transform;
  const x = (point.xCm - c.xCm) / l.xx;
  const y = (point.distanceToPlateCm - c.distanceToPlateCm - l.yx * x) / l.yy;
  const z = (point.zCm - c.zCm - l.zx * x - l.zy * y) / l.zz;
  return Math.hypot(x, y, z);
}

export function classifyPitchReference(
  point: Position,
  distribution: PitchReferenceDistribution | null,
): PitchReferenceBand | null {
  if (distribution === null) return null;
  const distance = pitchReferenceDistance(point, distribution);
  return inside(distance, distribution.central50.radius)
    ? "core50"
    : inside(distance, distribution.central90.radius)
      ? "shell90"
      : "outside90";
}

export function fitPitchReferenceDistribution(
  input: readonly Position[],
): PitchReferenceDistribution | null {
  if (input.length < 4) return null;
  if (input.some((p) => ![p.xCm, p.distanceToPlateCm, p.zCm].every(Number.isFinite)))
    throw new Error("Non-finite pitch reference position");
  const points = [...input].sort(compare),
    n = points.length;
  const center = { xCm: 0, distanceToPlateCm: 0, zCm: 0 };
  for (const p of points) {
    center.xCm += p.xCm / n;
    center.distanceToPlateCm += p.distanceToPlateCm / n;
    center.zCm += p.zCm / n;
  }
  let xx = regularizationCm2,
    yy = regularizationCm2,
    zz = regularizationCm2;
  let xy = 0,
    xz = 0,
    yz = 0;
  for (const p of points) {
    const x = p.xCm - center.xCm,
      y = p.distanceToPlateCm - center.distanceToPlateCm;
    const z = p.zCm - center.zCm;
    xx += (x * x) / n;
    yy += (y * y) / n;
    zz += (z * z) / n;
    xy += (x * y) / n;
    xz += (x * z) / n;
    yz += (y * z) / n;
  }
  const lxx = Math.sqrt(xx),
    lyx = xy / lxx,
    lzx = xz / lxx;
  const lyy = Math.sqrt(yy - lyx * lyx),
    lzy = (yz - lzx * lyx) / lyy;
  const lzz = Math.sqrt(zz - lzx * lzx - lzy * lzy);
  if (![lxx, lyy, lzz].every((v) => Number.isFinite(v) && v > 0))
    throw new Error("Invalid pitch reference covariance");
  const distribution: PitchReferenceDistribution = {
    modelVersion: 1,
    method: "empirical_mahalanobis",
    sampleCount: n,
    regularizationCm2,
    center,
    transform: { xx: lxx, yx: lyx, yy: lyy, zx: lzx, zy: lzy, zz: lzz },
    central50: { radius: 0, includedCount: 0 },
    central90: { radius: 0, includedCount: 0 },
  };
  // Calibrate coverage on the observed pitches; a Gaussian/chi-square cutoff would
  // imply an unverified distribution, especially when left/right arms are pooled.
  const distances = points
    .map((p) => pitchReferenceDistance(p, distribution))
    .sort((a, b) => a - b);
  for (const [coverage, field] of [
    [0.5, "central50"],
    [0.9, "central90"],
  ] as const) {
    const radius = distances[Math.ceil(n * coverage) - 1];
    if (radius === undefined) throw new Error("Missing pitch reference quantile");
    distribution[field] = {
      radius,
      includedCount: distances.filter((d) => inside(d, radius)).length,
    };
  }
  return distribution;
}

function summarize(
  points: readonly PitchAnalysisPoint[],
  hasDistribution: boolean,
): PitchExpectationGroup {
  const n = points.length;
  const mean = (key: "xCm" | "zCm" | "distanceToPlateCm" | "timingDifferenceMs") =>
    n === 0 ? null : points.reduce((sum, p) => sum + p[key] / n, 0);
  const sd = (key: "xCm" | "zCm" | "timingDifferenceMs") => {
    const average = mean(key);
    return average === null
      ? null
      : Math.sqrt(points.reduce((sum, p) => sum + (p[key] - average) ** 2 / n, 0));
  };
  const swings = points.filter((p) => p.swing).length;
  const whiffs = points.filter((p) => p.whiff).length;
  return {
    count: n,
    meanXCm: mean("xCm"),
    meanZCm: mean("zCm"),
    meanDepthCm: mean("distanceToPlateCm"),
    meanTimingMs: mean("timingDifferenceMs"),
    sdXCm: sd("xCm"),
    sdZCm: sd("zCm"),
    sdTimingMs: sd("timingDifferenceMs"),
    outside90Count: hasDistribution
      ? points.filter((p) => p.referenceBand === "outside90").length
      : null,
    swings,
    whiffs,
    whiffRate: swings === 0 ? null : whiffs / swings,
  };
}

export function summarizePitchExpectation(
  input: readonly PitchAnalysisPoint[],
  distribution: PitchReferenceDistribution | null,
): PitchExpectation {
  if (
    input.some(
      (p) => (p.whiff && !p.swing) || p.referenceBand !== classifyPitchReference(p, distribution),
    )
  )
    throw new Error("Inconsistent pitch expectation input");
  const points = [...input].sort(
    (a, b) => compare(a, b) || a.timingDifferenceMs - b.timingDifferenceMs,
  );
  const provider = new Map<string | null, PitchAnalysisPoint[]>();
  const clusters = new Map<number | null, PitchAnalysisPoint[]>();
  for (const p of points) {
    const ps = provider.get(p.pitchType) ?? [];
    ps.push(p);
    provider.set(p.pitchType, ps);
    const cs = clusters.get(p.clusterId) ?? [];
    cs.push(p);
    clusters.set(p.clusterId, cs);
  }
  return {
    modelVersion: 1,
    providerGroups: [...provider]
      .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
      .map(([pitchType, members]) => ({ pitchType, ...summarize(members, distribution !== null) })),
    clusterGroups: [...clusters]
      .sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))
      .map(([clusterId, members]) => ({ clusterId, ...summarize(members, distribution !== null) })),
    bands:
      distribution === null
        ? []
        : (["core50", "shell90", "outside90"] as const).map((band) => ({
            band,
            ...summarize(
              points.filter((p) => p.referenceBand === band),
              true,
            ),
          })),
  };
}
