import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  resolveAnalysisScope,
  WorkloadComparisonResponseSchema,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";

export async function getWorkloadComparison(
  query: AnalysisScopeQuery,
  pitcherId: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    WorkloadComparisonResponseSchema,
    await requestJson(
      `/api/v2/analysis/pitcher-workload/${encodeURIComponent(pitcherId)}/comparison?${params}`,
      { signal },
    ),
  );
  if (
    result.pitcherId !== pitcherId ||
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(query, "regular"))
  )
    throw new Error("투수 운용 비교 범위가 다릅니다.");
  if (
    result.dimensions.length !== 5 ||
    result.roleEvidence.registeredPitches +
      result.roleEvidence.observedPitches +
      result.roleEvidence.unknownPitches !==
      result.actualPitches ||
    new Set(result.dimensions.map((d) => d.dimension)).size !== 5 ||
    result.dimensions.some(
      (d) =>
        d.groupedPitches + d.excludedWorkloadPitches + result.excludedConditionPitches !==
          result.actualPitches ||
        d.comparisons.some((r) => {
          const groups = [r.baseline, r.target];
          return (
            groups.some(
              (g) =>
                g.matchedSamples > g.samples ||
                g.matchedGames > g.games ||
                g.games > g.samples ||
                g.matchedGames > g.matchedSamples ||
                (g.samples === 0) !== (g.rawMean === null),
            ) ||
            (r.status === "ready"
              ? r.difference === null ||
                r.interval === null ||
                r.interval.low > r.interval.high ||
                groups.some(
                  (g) =>
                    g.adjustedMean === null ||
                    g.matchedGames < result.policy.minGroupGames ||
                    g.matchedSamples < result.policy.minGroupSamples,
                ) ||
                r.validReplicates < result.policy.minValidReplicates
              : r.difference !== null ||
                r.interval !== null ||
                groups.some((g) => g.adjustedMean !== null))
          );
        }),
    )
  )
    throw new Error("투수 운용 비교의 표본 또는 결과 상태가 다릅니다.");
  return result;
}
