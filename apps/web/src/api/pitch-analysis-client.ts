import {
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import {
  PitchAnalysisCatalogSchema,
  PitchAnalysisResponseSchema,
  type PitchAnalysisCatalog,
  type PitchAnalysisResponse,
  type PitchAnalysisPoint,
  type PitchExpectationGroup,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getPitchAnalysisCatalog(
  season: number,
  signal: AbortSignal,
  options: AnalysisScopeOptions = {},
): Promise<PitchAnalysisCatalog> {
  const result = Value.Decode(
    PitchAnalysisCatalogSchema,
    await requestJson(
      `/api/v2/analysis/pitch-shape?${new URLSearchParams(Object.entries({ season, ...options }).map(([k, v]) => [k, String(v)]))}`,
      { signal },
    ),
  );
  if (
    result.season !== season ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope({ season, ...options }))
  )
    throw new Error("분석 시즌이 요청과 일치하지 않습니다.");
  return result;
}

export async function getPitchAnalysis(
  season: number,
  pitcherId: string,
  signal: AbortSignal,
  clusterCount?: number,
  options: AnalysisScopeOptions = {},
): Promise<PitchAnalysisResponse> {
  const params = new URLSearchParams(
    Object.entries({
      season,
      ...options,
      ...(clusterCount === undefined ? {} : { clusterCount }),
    }).map(([k, v]) => [k, String(v)]),
  );
  const result = Value.Decode(
    PitchAnalysisResponseSchema,
    await requestJson(`/api/v2/analysis/pitch-shape/${encodeURIComponent(pitcherId)}?${params}`, {
      signal,
    }),
  );
  if (
    result.season !== season ||
    result.pitcherId !== pitcherId ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope({ season, ...options }))
  )
    throw new Error("분석 대상이 요청과 일치하지 않습니다.");
  if (
    result.calibration.calibratedCount !==
      result.points.filter((p) => p.calibrationStatus === "applied").length ||
    result.calibration.uncalibratedCount !==
      result.points.filter((p) => p.calibrationStatus !== "applied").length ||
    result.points.some((p) =>
      p.calibrationStatus === "applied"
        ? p.calibrationXcm === null || p.calibrationZcm === null
        : p.calibrationXcm !== null || p.calibrationZcm !== null,
    )
  )
    throw new Error("구장 보정 집계가 투구와 일치하지 않습니다.");
  const ids = new Set(result.points.flatMap((p) => (p.clusterId === null ? [] : [p.clusterId])));
  const typeCount = new Set(
    result.points.flatMap((p) => (p.pitchType === null ? [] : [p.pitchType])),
  ).size;
  const defaultCount = result.points.length === 0 ? 0 : Math.max(1, typeCount);
  const summary = result.clustering;
  if (
    summary.defaultClusterCount !== defaultCount ||
    summary.maxClusterCount !== Math.min(result.points.length, Math.max(12, typeCount)) ||
    summary.componentCount !== (clusterCount ?? defaultCount) ||
    ids.size !== summary.clusterCount ||
    result.points.filter((p) => p.clusterId === null).length !== summary.unassignedCount ||
    [...ids].some((id) => id > summary.componentCount) ||
    (summary.status === "ready"
      ? summary.unassignedCount !== 0 || result.points.length === 0
      : ids.size !== 0) ||
    (summary.status === "empty" && result.points.length !== 0)
  ) {
    throw new Error("분석 클러스터 집계가 투구와 일치하지 않습니다.");
  }
  validateExpectation(result);
  return result;
}

function validateExpectation(result: PitchAnalysisResponse): void {
  const d = result.referenceDistribution;
  const invalid = () => {
    throw new Error("포심 비교 집계가 투구와 일치하지 않습니다.");
  };
  if (
    d !== null &&
    (d.sampleCount !== result.baseline?.sampleCount ||
      d.central50.radius > d.central90.radius ||
      d.central50.includedCount < Math.ceil(d.sampleCount * 0.5) ||
      d.central90.includedCount < Math.ceil(d.sampleCount * 0.9) ||
      d.central50.includedCount > d.central90.includedCount ||
      d.central90.includedCount > d.sampleCount)
  )
    invalid();
  if (
    result.points.some((p) => (p.whiff && !p.swing) || (p.referenceBand === null) !== (d === null))
  )
    invalid();
  const check = (group: PitchExpectationGroup, points: PitchAnalysisPoint[]) => {
    const swings = points.filter((p) => p.swing).length;
    const whiffs = points.filter((p) => p.whiff).length;
    if (
      group.count !== points.length ||
      group.swings !== swings ||
      group.whiffs !== whiffs ||
      group.whiffRate !== (swings === 0 ? null : whiffs / swings) ||
      group.outside90Count !==
        (d === null ? null : points.filter((p) => p.referenceBand === "outside90").length)
    )
      invalid();
  };
  const { providerGroups, clusterGroups, bands } = result.expectation;
  if (
    new Set(providerGroups.map((g) => g.pitchType)).size !== providerGroups.length ||
    providerGroups.length !== new Set(result.points.map((p) => p.pitchType)).size ||
    new Set(clusterGroups.map((g) => g.clusterId)).size !== clusterGroups.length ||
    clusterGroups.length !== new Set(result.points.map((p) => p.clusterId)).size ||
    bands.length !== (d === null ? 0 : 3) ||
    new Set(bands.map((g) => g.band)).size !== bands.length
  )
    invalid();
  for (const g of providerGroups) {
    const points = result.points.filter((p) => p.pitchType === g.pitchType);
    if (points.length === 0) invalid();
    check(g, points);
  }
  for (const g of clusterGroups) {
    const points = result.points.filter((p) => p.clusterId === g.clusterId);
    if (points.length === 0) invalid();
    check(g, points);
  }
  for (const g of bands)
    check(
      g,
      result.points.filter((p) => p.referenceBand === g.band),
    );
}
