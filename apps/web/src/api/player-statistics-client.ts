import {
  canonicalStringify,
  resolveAnalysisScope,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  PlayerSeasonStatisticsResponseSchema,
  PlayerGameRecordsResponseSchema,
  PlayerLeagueResponseSchema,
  PlayerSplitResponseSchema,
  playerSplitBuckets,
  type BattingStatisticsQuery,
  type PitchingStatisticsQuery,
  type PlayerSeasonStatisticsQuery,
  type PlayerGameRecordsQuery,
  type PlayerSplitQuery,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "./transport";

export async function getPlayerLeague(query: PlayerGameRecordsQuery, signal: AbortSignal) {
  const { player, role, source, ...scope } = query;
  void player;
  void source;
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PlayerLeagueResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/player-league?${params}`, { signal }),
  );
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope)) ||
    result.role !== role
  )
    throw new Error("리그 비교의 조회 범위가 요청과 다릅니다.");
  return result;
}

export async function getPlayerGameRecords(query: PlayerGameRecordsQuery, signal: AbortSignal) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PlayerGameRecordsResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/player-games?${params}`, { signal }),
  );
  const { player, role, source, ...scope } = query;
  void player;
  void source;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope)) ||
    result.role !== role ||
    new Set(result.rows.map(({ gameId }) => gameId)).size !== result.rows.length ||
    result.rows.some(
      ({ gameDate }, index) =>
        !gameDate.startsWith(`${scope.season}-`) ||
        (scope.dateFrom !== undefined && gameDate < scope.dateFrom) ||
        (scope.dateTo !== undefined && gameDate > scope.dateTo) ||
        gameDate > (result.rows[index - 1]?.gameDate ?? gameDate),
    )
  )
    throw new Error("경기별 기록의 조회 범위가 요청과 다릅니다.");
  return result;
}

export async function getPlayerSplits(query: PlayerSplitQuery, signal: AbortSignal) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PlayerSplitResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/player-splits?${params}`, { signal }),
  );
  const { player, role, source, split, countFor, ...scope } = query;
  void player;
  void role;
  void source;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope)) ||
    canonicalStringify(result.rows.map(({ bucket }) => bucket)) !==
      canonicalStringify(playerSplitBuckets[split]) ||
    (countFor === undefined
      ? result.byCount !== undefined
      : result.byCount === undefined ||
        result.byCount.reduce((total, row) => total + row.plateAppearances, 0) !==
          result.rows.find((row) => row.bucket === countFor)?.plateAppearances)
  )
    throw new Error("상황별 기록의 조회 범위가 요청과 다릅니다.");
  return result;
}

export async function getPlayerSeasonStatistics(
  query: PlayerSeasonStatisticsQuery,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const result = Value.Decode(
    PlayerSeasonStatisticsResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/player-seasons?${params}`, { signal }),
  );
  const validSeasons = (rows: readonly { season: number }[]) =>
    rows.every(
      ({ season }, index) =>
        (query.season === undefined || season === query.season) &&
        season > (rows[index + 1]?.season ?? 0),
    );
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    !validSeasons(result.batting) ||
    !validSeasons(result.pitching) ||
    (query.sourceRole === "batter" && result.pitching.length > 0) ||
    (query.sourceRole === "pitcher" && result.batting.length > 0)
  ) {
    throw new Error("연도별 성적 조회 범위가 요청과 다릅니다.");
  }
  return result;
}

export async function getBattingStatistics(query: BattingStatisticsQuery, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    BattingStatisticsResponseSchema,
    await requestJson(`/api/v2/analysis/statistics/batting?${params}`, { signal }),
  );
  const { group, playerId, sort, minPA, page, limit, ...scope } = query;
  void sort;
  void minPA;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    result.group !== (group ?? "player") ||
    result.page !== (page ?? 1) ||
    result.limit !== (limit ?? 50) ||
    (playerId !== undefined && result.rows.some((row) => row.playerId !== playerId)) ||
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
  const { group, playerId, sort, minBF, page, limit, ...scope } = query;
  void sort;
  void minBF;
  if (
    canonicalStringify(result.query) !== canonicalStringify(query) ||
    result.group !== (group ?? "player") ||
    result.page !== (page ?? 1) ||
    result.limit !== (limit ?? 50) ||
    (playerId !== undefined && result.rows.some((row) => row.playerId !== playerId)) ||
    canonicalStringify(result.scope) !== canonicalStringify(resolveAnalysisScope(scope, "regular"))
  )
    throw new Error("성적 조회 범위가 요청과 다릅니다.");
  return result;
}
