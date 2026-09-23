import type { AnalysisScopeOptions } from "@kbo/contracts";
import { getDisciplineCatalog } from "./batter-discipline-client";
import { getPitchAnalysisCatalog } from "./pitch-analysis-client";

function catalogScope(season: number, options: AnalysisScopeOptions) {
  // Both catalog endpoints default to all games. Explicit and implicit defaults
  // identify the same catalog; each page still validates its URL before fetching.
  return {
    season,
    competition: options.competition ?? "all",
    dateFrom: options.dateFrom ?? null,
    dateTo: options.dateTo ?? null,
  };
}

export function pitcherCatalogQueryOptions(season: number, options: AnalysisScopeOptions) {
  return {
    queryKey: ["analysis-catalog", "pitchers", catalogScope(season, options)] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getPitchAnalysisCatalog(season, signal, options),
  };
}

export function batterCatalogQueryOptions(season: number, options: AnalysisScopeOptions) {
  return {
    queryKey: ["analysis-catalog", "batters", catalogScope(season, options)] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => getDisciplineCatalog(season, signal, options),
  };
}
