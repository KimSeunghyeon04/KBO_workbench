import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchOutcomeQuerySchema,
  PitchLocationResponseSchema,
  PitchLocationComparisonQuerySchema,
  PitchLocationComparisonResponseSchema,
  PitchAnalysisPitcherParamsSchema,
} from "@kbo/contracts";
import { PitchLocationRepository, type PitchOutcomeCache } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
type Options = Pick<RouteContext, "pool"> & { outcomeSamples?: PitchOutcomeCache };
export const pitchLocationRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const repository = new PitchLocationRepository(context.pool, context.outcomeSamples);
  app.get(
    "/api/v2/analysis/pitch-location/:pitcherId/comparison",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchLocationComparisonQuerySchema,
        response: {
          200: PitchLocationComparisonResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    (request) => repository.compare(request.query, request.params.pitcherId),
  );
  app.get(
    "/api/v2/analysis/pitch-location/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchOutcomeQuerySchema,
        response: { 200: PitchLocationResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.pitcherId),
  );
};
