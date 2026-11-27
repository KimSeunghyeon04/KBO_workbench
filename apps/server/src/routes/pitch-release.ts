import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchAnalysisPitcherParamsSchema,
  PitchReleaseQuerySchema,
  PitchReleaseResponseSchema,
} from "@kbo/contracts";
import { PitchReleaseRepository } from "@kbo/persistence";
import type { ComputationRunner } from "../computation.js";
import type { RouteContext } from "./context.js";
import { createPitchReleaseComputation } from "../pitch-analysis-computation.js";

export const pitchReleaseRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { computation: ComputationRunner }
> = async (app, { pool, computation }) => {
  const repository = new PitchReleaseRepository(pool);
  const estimate = createPitchReleaseComputation(computation);
  app.get(
    "/api/v2/analysis/pitch-release/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchReleaseQuerySchema,
        response: { 200: PitchReleaseResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { rows, ...snapshot } = await repository.read(request.query, request.params.pitcherId);
      return { ...snapshot, groups: await estimate(rows) };
    },
  );
};
