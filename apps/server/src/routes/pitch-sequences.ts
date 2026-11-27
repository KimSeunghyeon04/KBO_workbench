import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchSequenceQuerySchema,
  PitchSequenceResponseSchema,
  PitchAnalysisPitcherParamsSchema,
} from "@kbo/contracts";
import { PitchSequenceRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
import type { ComputationRunner } from "../computation.js";
import { createPitchReleaseComputation } from "../pitch-analysis-computation.js";
export const pitchSequenceRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { computation: ComputationRunner }
> = async (app, { pool, computation }) => {
  const repository = new PitchSequenceRepository(pool, createPitchReleaseComputation(computation));
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
