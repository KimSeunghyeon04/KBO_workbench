import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchSequenceQuerySchema,
  PitchSequenceResponseSchema,
  PitchAnalysisPitcherParamsSchema,
} from "@kbo/contracts";
import { PitchSequenceRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const pitchSequenceRoutes: FastifyPluginAsyncTypebox<Pick<RouteContext, "pool">> = async (
  app,
  { pool },
) => {
  const repository = new PitchSequenceRepository(pool);
  app.get(
    "/api/v2/analysis/pitch-sequences/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchSequenceQuerySchema,
        response: { 200: PitchSequenceResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.pitcherId),
  );
};
