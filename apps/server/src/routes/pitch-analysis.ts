import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchAnalysisCatalogSchema,
  PitchAnalysisPitcherParamsSchema,
  PitchAnalysisQuerySchema,
  PitchAnalysisDetailQuerySchema,
  PitchAnalysisResponseSchema,
  type PitchAnalysisSample,
} from "@kbo/contracts";
import {
  PitchAnalysisRepository,
  type PitchReferenceWorkspace,
  type PitchCalibrationWorkspace,
  type PitchAnalysisComputation,
} from "@kbo/persistence";

import type { RouteContext } from "./context.js";
import { PitchAnalysisService } from "../pitch-analysis-service.js";
import { BoundedReadCache } from "../bounded-read-cache.js";

type Options = Pick<RouteContext, "pool"> & {
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  computation?: PitchAnalysisComputation;
  calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">;
};

export const pitchAnalysisRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const samples = new BoundedReadCache<PitchAnalysisSample>(32 * 1024 * 1024, 32, 300_000);
  const repository = new PitchAnalysisRepository(
    context.pool,
    context.references,
    context.computation,
    samples,
    context.calibrations,
  );
  const service = new PitchAnalysisService(repository);
  app.addHook("onClose", async () => {
    await service.close();
    samples.clear();
  });
  app.get(
    "/api/v2/analysis/pitch-shape",
    {
      schema: {
        querystring: PitchAnalysisQuerySchema,
        response: { 200: PitchAnalysisCatalogSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { season, ...scope } = request.query;
      return repository.catalog(season, scope);
    },
  );
  app.get(
    "/api/v2/analysis/pitch-shape/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: PitchAnalysisDetailQuerySchema,
        response: {
          200: PitchAnalysisResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { season, clusterCount, ...scope } = request.query;
      return service.analyze(season, request.params.pitcherId, clusterCount, scope);
    },
  );
};
