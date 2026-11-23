interface AnalysisQueryMeta extends Record<string, unknown> {
  analysis?: {
    seasons: readonly number[] | "all";
    usesModels: boolean;
  };
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: AnalysisQueryMeta;
  }
}

export function analysisQueryMeta(
  scope: number | { season: number; compareSeason?: number },
  dependency?: "models",
): AnalysisQueryMeta {
  const seasons =
    typeof scope === "number"
      ? [scope]
      : scope.compareSeason === undefined
        ? [scope.season]
        : [scope.season, scope.compareSeason];
  return { analysis: { seasons, usesModels: dependency === "models" } };
}
