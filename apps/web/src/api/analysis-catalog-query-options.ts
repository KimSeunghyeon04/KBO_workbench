import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { defaultAnalysisCompetition, type AnalysisScopeOptions } from "@kbo/contracts";
import { getDisciplineCatalog } from "./batter-discipline-client";
import { getPitchAnalysisCatalog } from "./pitch-analysis-client";

function catalogQueryOptions<Role extends "pitchers" | "batters">(
  role: Role,
  season: number,
  options: AnalysisScopeOptions,
) {
  const scope = {
    season,
    competition: options.competition ?? defaultAnalysisCompetition,
    dateFrom: options.dateFrom ?? null,
    dateTo: options.dateTo ?? null,
  };
  return {
    queryKey: ["analysis-catalog", role, scope] as const,
    meta: analysisQueryMeta(season),
    // AnalysisRefreshBoundary invalidates the catalog when its season changes.
    refetchOnWindowFocus: false,
  };
}

export function pitcherCatalogQueryOptions(season: number, options: AnalysisScopeOptions) {
  return {
    ...catalogQueryOptions("pitchers", season, options),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getPitchAnalysisCatalog(season, signal, options),
  };
}

export function batterCatalogQueryOptions(season: number, options: AnalysisScopeOptions) {
  return {
    ...catalogQueryOptions("batters", season, options),
    queryFn: ({ signal }: { signal: AbortSignal }) => getDisciplineCatalog(season, signal, options),
  };
}
