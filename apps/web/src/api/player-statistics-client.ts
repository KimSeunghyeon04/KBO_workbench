import {
  canonicalStringify,
  resolveAnalysisScope,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  type BattingStatisticsQuery,
  type PitchingStatisticsQuery,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "./transport";
export async function getBattingStatistics(query: BattingStatisticsQuery, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    BattingStatisticsResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/batting?${params}`, { signal }),
  );
  const { group, sort, minPA, page, limit, ...scope } = query;
  void sort;
  void minPA;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    result.group !== (group ?? "player") ||
    result.page !== (page ?? 1) ||
    result.limit !== (limit ?? 50) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope, "regular"))
  )
    throw new Error("성적 조회 범위가 요청과 다릅니다.");
  return result;
}
export async function getPitchingStatistics(query: PitchingStatisticsQuery, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    PitchingStatisticsResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/pitching?${params}`, { signal }),
  );
  const { group, sort, minBF, page, limit, ...scope } = query;
  void sort;
  void minBF;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    result.group !== (group ?? "player") ||
    result.page !== (page ?? 1) ||
    result.limit !== (limit ?? 50) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope, "regular"))
  )
    throw new Error("성적 조회 범위가 요청과 다릅니다.");
  return result;
}
