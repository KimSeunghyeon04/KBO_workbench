import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchOutcomeQuerySchema,
  BatterProfileResponseSchema,
  DisciplineParamsSchema,
  BatterPeriodQuerySchema,
  BatterPeriodResponseSchema,
  analysisPeriodQueries,
} from "@kbo/contracts";
import { compareBatterProfilePeriods } from "@kbo/game-core";
import { periodSnapshot } from "../analysis-period-pair.js";
import { BatterProfileRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const batterProfileRoutes: FastifyPluginAsyncTypebox<Pick<RouteContext, "pool">> = async (
  app,
  context,
) => {
  const repository = new BatterProfileRepository(context.pool);
  app.get(
    "/api/v2/analysis/batter-profile/:batterId/comparison",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: BatterPeriodQuerySchema,
        response: { 200: BatterPeriodResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { first, second } = analysisPeriodQueries(request.query);
      const playerId = request.params.batterId;
      const pair = await repository.compare(first, second, playerId);
      const snapshot = (d: typeof pair.first) =>
        periodSnapshot(
          d.query,
          d.sourceHash,
          [
            { label: "실제 투구", count: d.total.pitches },
            { label: "코스 확인", count: d.coverage.locationPitches },
            { label: "완료 PA", count: d.plateAppearances.total.pa },
            { label: "종결 구종 미귀속", count: d.plateAppearances.unattributed },
          ],
          "regular",
        );
      return {
        query: request.query,
        playerId,
        first: snapshot(pair.first),
        second: snapshot(pair.second),
        metrics: compareBatterProfilePeriods(pair.first, pair.second),
        warnings: [
          "반응은 투구·스윙 기준이며 AVG·SLG는 완료 PA의 종결 구종 기준입니다. 타석 결과를 모든 구종에 중복 귀속하지 않습니다.",
          "같은 경기 종류·구종·카운트·타석 좌우·표본 조건을 적용합니다. 상대 투수와 구장 구성 차이는 조정하지 않습니다.",
        ],
      };
    },
  );
  app.get(
    "/api/v2/analysis/batter-profile/:batterId",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: PitchOutcomeQuerySchema,
        response: { 200: BatterProfileResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.batterId),
  );
};
