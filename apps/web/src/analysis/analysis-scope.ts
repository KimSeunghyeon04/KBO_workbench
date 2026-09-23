import {
  AnalysisScopeQuerySchema,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

export function scopeFromParams(
  season: number,
  params: URLSearchParams,
): { options: AnalysisScopeOptions; error: string | null } {
  const candidate = {
    season,
    ...Object.fromEntries(
      ["competition", "dateFrom", "dateTo"].flatMap((key) => {
        const value = params.get(key);
        return value === null || (value === "" && key !== "competition") ? [] : [[key, value]];
      }),
    ),
  };
  if (!Value.Check(AnalysisScopeQuerySchema, candidate))
    return { options: {}, error: "분석 범위가 올바르지 않습니다." };
  try {
    resolveAnalysisScope(candidate);
  } catch (error) {
    return { options: {}, error: error instanceof Error ? error.message : "잘못된 분석 범위" };
  }
  const { season: unused, ...options } = candidate;
  void unused;
  return { options, error: null };
}

export function changeAnalysisParams(
  params: URLSearchParams,
  key: string,
  value: string,
  seasonSelectionKeys: readonly ("pitcher" | "batter")[] = [],
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === "") next.delete(key);
  else next.set(key, value);
  if (key === "season") {
    for (const dependent of ["dateFrom", "dateTo", ...seasonSelectionKeys]) next.delete(dependent);
  }
  return next;
}

// Carry only the shared scope: player selection, sorting and chart settings belong
// to the source page and must not leak into another analysis.
export function analysisScopeSearch(season: number, options: AnalysisScopeOptions): string {
  return new URLSearchParams(
    Object.entries({ season, ...options }).map(([key, value]) => [key, String(value)]),
  ).toString();
}
