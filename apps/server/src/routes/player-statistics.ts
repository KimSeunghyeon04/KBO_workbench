import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  BattingStatisticsResponseSchema,
  PitchingStatisticsResponseSchema,
} from "@kbo/contracts";
import { PlayerStatisticsRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const playerStatisticsRoutes: FastifyPluginAsyncTypebox<Pick<RouteContext, "pool">> = async (
  app,
  context,
) => {
  const repository = new PlayerStatisticsRepository(context.pool);
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
