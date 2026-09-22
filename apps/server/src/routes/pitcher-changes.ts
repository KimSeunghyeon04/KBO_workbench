import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitcherChangesQuerySchema,
  PitcherChangesResponseSchema,
  PitchAnalysisPitcherParamsSchema,
  type PitcherChangesResponse,
} from "@kbo/contracts";
import {
  PitcherChangesRepository,
  type PitchAnalysisComputation,
  type PitchReferenceWorkspace,
  type PitchCalibrationWorkspace,
} from "@kbo/persistence";
import { BoundedReadCache } from "../bounded-read-cache.js";
import type { RouteContext } from "./context.js";
type Options = Pick<RouteContext, "pool"> & {
  computation: PitchAnalysisComputation;
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  calibrations: Pick<PitchCalibrationWorkspace, "getOrCreate">;
};
export const pitcherChangesRoutes: FastifyPluginAsyncTypebox<Options> = async (app, options) => {
  const repository = new PitcherChangesRepository(options.pool, {
    ...options,
    cache: new BoundedReadCache<PitcherChangesResponse>(16 * 1024 * 1024, 8, 300000),
  });
  app.get(
    "/api/v2/analysis/pitcher-changes/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitcherChangesQuerySchema,
        response: { 200: PitcherChangesResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.pitcherId),
  );
};
