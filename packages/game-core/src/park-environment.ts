import type {
  AnalysisScope,
  ParkEnvironmentRow,
  ParkEnvironmentModel,
  ParkEnvironmentResponse,
} from "@kbo/contracts";
function stats(
  rows: readonly ParkEnvironmentRow[],
): ParkEnvironmentResponse["parks"][number]["total"] {
  const sum = (
      key: "pa" | "homeRuns" | "runs" | "completeHalves" | "completeRuns" | "excludedHalves",
    ) => rows.reduce((s, r) => s + r[key], 0),
    pa = sum("pa"),
    runs = sum("runs"),
    homeRuns = sum("homeRuns"),
    completeHalves = sum("completeHalves"),
    completeRuns = sum("completeRuns");
  return {
    games: new Set(rows.map((r) => r.gameId)).size,
    pa,
    runs,
    homeRuns,
    completeHalves,
    completeRuns,
    excludedHalves: sum("excludedHalves"),
    runRate: pa === 0 ? null : runs / pa,
    homeRunRate: pa === 0 ? null : homeRuns / pa,
    completeRunRate: completeHalves === 0 ? null : completeRuns / completeHalves,
  };
}
export function analyzeParkEnvironment(
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly ParkEnvironmentRow[],
  model: ParkEnvironmentModel | null,
  modelHash: string | null,
): ParkEnvironmentResponse {
  const groups = new Map<string, ParkEnvironmentRow[]>(),
    games = new Map<string, ParkEnvironmentRow>();
  for (const row of rows) {
    const key = row.parkId ?? JSON.stringify([row.season, row.stadium]),
      g = groups.get(key) ?? [];
    g.push(row);
    groups.set(key, g);
    games.set(row.gameId, row);
  }
  return {
    version: 1,
    scope,
    sourceHash,
    rows: rows.length,
    games: games.size,
    unknownParkGames: [...games.values()].filter((r) => r.parkId === null).length,
    parks: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, group]) => ({
        key,
        parkId: group[0]?.parkId ?? null,
        stadiums: [
          ...new Set(group.flatMap((r) => (r.stadium === null ? [] : [r.stadium]))),
        ].sort(),
        total: stats(group),
        home: stats(group.filter((r) => r.side === "home")),
        away: stats(group.filter((r) => r.side === "away")),
      })),
    modelHash,
    model,
    modelStatus:
      scope.competition !== "regular" || scope.dateFrom !== null || scope.dateTo !== null
        ? "scope_mismatch"
        : model === null
          ? "model_unavailable"
          : model.metrics.some((m) => m.adopted)
            ? "ready"
            : "not_adopted",
    evidence: [...games.values()]
      .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : 0))
      .map((r) => ({
        gameId: r.gameId,
        revision: r.revision,
        gameDate: r.gameDate,
        stadium: r.stadium,
        parkId: r.parkId,
      })),
    weather: "excluded_no_confirmed_start_time",
  };
}
