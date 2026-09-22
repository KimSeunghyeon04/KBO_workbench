import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchOutcomeQuerySchema,
  PitchLocationResponseSchema,
  PitchAnalysisPitcherParamsSchema,
} from "@kbo/contracts";
import { PitchLocationRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const pitchLocationRoutes: FastifyPluginAsyncTypebox<Pick<RouteContext, "pool">> = async (
  app,
  context,
) => {
  const repository = new PitchLocationRepository(context.pool);
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
