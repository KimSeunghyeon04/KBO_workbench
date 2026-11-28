import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PlayerDirectorySchema,
  PlayerGameRecordsQuerySchema,
  PlayerGameRecordsResponseSchema,
  PlayerLeagueResponseSchema,
  PlayerSplitQuerySchema,
  PlayerSplitResponseSchema,
  PlayerSeasonStatisticsQuerySchema,
  PlayerSeasonStatisticsResponseSchema,
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
  StatisticsPeriodQuerySchema,
  StatisticsPeriodResponseSchema,
  analysisPeriodQueries,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { compareBattingPeriods, comparePitchingPeriods } from "@kbo/game-core";
import { resolveNaverPitcherHand } from "@kbo/collection";
import { readAnalysisPeriodPair, periodSnapshot } from "../analysis-period-pair.js";
import {
  PlayerDirectoryRepository,
  PlayerStatisticsRepository,
  readOfficialPlayerBirthYears,
  readOfficialPlayerCareers,
} from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const playerStatisticsRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { careerRoot?: string }
> = async (app, context) => {
  const repository = new PlayerStatisticsRepository(context.pool);
  const root = context.careerRoot;
  const directory = new PlayerDirectoryRepository(
    context.pool,
    root === undefined ? undefined : () => readOfficialPlayerCareers(root),
    root === undefined ? undefined : () => readOfficialPlayerBirthYears(root),
  );
  app.get(
    "/api/v2/analysis/statistics/player-league",
    {
      schema: {
        querystring: PlayerGameRecordsQuerySchema,
        response: { 200: PlayerLeagueResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.playerLeague(request.query),
  );
  app.get(
    "/api/v2/analysis/players",
    {
      schema: {
        querystring: Type.Object({}, { additionalProperties: false }),
        response: { 200: PlayerDirectorySchema, 500: ApiErrorSchema },
      },
    },
    () => directory.list(),
  );
  app.get(
    "/api/v2/analysis/statistics/player-games",
    {
      schema: {
        querystring: PlayerGameRecordsQuerySchema,
        response: {
          200: PlayerGameRecordsResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request) => repository.playerGames(request.query),
  );
  app.get(
    "/api/v2/analysis/statistics/player-splits",
    {
      schema: {
        querystring: PlayerSplitQuerySchema,
        response: { 200: PlayerSplitResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.playerSplits(request.query, resolveNaverPitcherHand),
  );
  app.get(
    "/api/v2/analysis/statistics/player-seasons",
    {
      schema: {
        querystring: PlayerSeasonStatisticsQuerySchema,
        response: {
          200: PlayerSeasonStatisticsResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request) => repository.playerSeasons(request.query),
  );
  app.get(
    "/api/v2/analysis/statistics/:playerId/comparison",
    {
      schema: {
        params: Type.Object(
          { playerId: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        querystring: StatisticsPeriodQuerySchema,
        response: { 200: StatisticsPeriodResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { role, ...periods } = request.query;
      const { first, second } = analysisPeriodQueries(periods);
      const playerId = request.params.playerId;
      if (role === "batter") {
        const { first: a, second: b } = await readAnalysisPeriodPair(
          () => repository.compareBatting(first, second, playerId),
          () => repository.readSourceHash(first),
        );
        const pair = { first: a.response, second: b.response };
        if (
          pair.first.total > pair.first.rows.length ||
          pair.second.total > pair.second.rows.length
        )
          throw new Error("기간 비교 기록이 잘렸습니다.");
        return {
          playerId,
          query: request.query,
          first: periodSnapshot(first, pair.first.sourceHash, [
            { label: "팀별 기록", count: pair.first.total },
          ]),
          second: periodSnapshot(second, pair.second.sourceHash, [
            { label: "팀별 기록", count: pair.second.total },
          ]),
          metrics: compareBattingPeriods(pair.first.rows, pair.second.rows),
          warnings: [
            "수집 경기 기준입니다. 이적 전후 기록의 분자·분모를 합산하며 구종·카운트·코스 조건은 적용하지 않습니다.",
          ],
        };
      }
      const { first: a, second: b } = await readAnalysisPeriodPair(
        () => repository.comparePitching(first, second, playerId),
        () => repository.readSourceHash(first),
      );
      const pair = { first: a.response, second: b.response };
      if (pair.first.total > pair.first.rows.length || pair.second.total > pair.second.rows.length)
        throw new Error("기간 비교 기록이 잘렸습니다.");
      return {
        playerId,
        query: request.query,
        first: periodSnapshot(first, pair.first.sourceHash, [
          { label: "팀별 기록", count: pair.first.total },
        ]),
        second: periodSnapshot(second, pair.second.sourceHash, [
          { label: "팀별 기록", count: pair.second.total },
        ]),
        metrics: comparePitchingPeriods(pair.first.rows, pair.second.rows),
        warnings: [
          "자책점 미제공 경기가 있으면 전체 ERA는 미확정입니다. ER 확인 경기 ERA는 확인된 경기의 자책점·아웃만 사용합니다.",
          "이적 전후 분자·분모를 합산합니다. 구종·카운트·코스 조건은 적용하지 않습니다.",
        ],
      };
    },
  );
  app.get(
    "/api/v2/analysis/statistics/batting",
    {
      schema: {
        querystring: BattingStatisticsQuerySchema,
        response: {
          200: BattingStatisticsResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request) => repository.batting(request.query),
  );
  app.get(
    "/api/v2/analysis/statistics/pitching",
    {
      schema: {
        querystring: PitchingStatisticsQuerySchema,
        response: {
          200: PitchingStatisticsResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request) => repository.pitching(request.query),
  );
};
