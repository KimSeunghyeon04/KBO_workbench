import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  AnalysisCoverageQuerySchema,
  AnalysisCoverageResultSchema,
} from "@kbo/contracts";
import {
  AnalysisCoverageRepository,
  type AnalysisCoverageWorkspace,
  type CoverageSeason,
  type PitchAnalysisComputation,
  type PitchCalibrationWorkspace,
} from "@kbo/persistence";
import type { Pool } from "pg";
import { BoundedReadCache } from "../bounded-read-cache.js";
import { AnalysisCoverageJobManager } from "../jobs/analysis-coverage-job-manager.js";

type Options = {
  pool: Pool;
  calibrations?: Pick<PitchCalibrationWorkspace, "getOrCreate">;
  summaries?: Pick<AnalysisCoverageWorkspace, "read" | "write">;
  calibrate: PitchAnalysisComputation["calibration"];
};
export const analysisCoverageRoutes: FastifyPluginAsyncTypebox<Options> = async (app, options) => {
  const cache = new BoundedReadCache<CoverageSeason>(16 * 1024 * 1024, 16, 300_000);
  const repository = new AnalysisCoverageRepository(
    options.pool,
    options.calibrations,
    options.calibrate,
    cache,
    options.summaries,
  );
  const jobs = new AnalysisCoverageJobManager(
    ({ scope }, signal) =>
      repository.read(scope.season, { competition: scope.competition }, signal),
    (error) => app.log.error({ err: error }, "Coverage preparation failed"),
  );
  app.addHook("onClose", async () => {
    await jobs.close();
    cache.clear();
  });
  const schema = {
    querystring: AnalysisCoverageQuerySchema,
    response: {
      200: AnalysisCoverageResultSchema,
      202: AnalysisCoverageResultSchema,
      400: ApiErrorSchema,
      500: ApiErrorSchema,
      503: ApiErrorSchema,
    },
  };
  for (const method of ["GET", "POST"] as const) {
    app.route({
      method,
      url: method === "GET" ? "/api/v2/analysis/coverage" : "/api/v2/analysis/coverage/prepare",
      schema,
      async handler(request, reply) {
        const { season, ...scope } = request.query;
        const inspection = await repository.inspect(season, scope);
        reply.header("Cache-Control", "no-store");
        if (inspection.response !== null) return inspection.response;
        const status = jobs.ensure(inspection, method === "POST");
        if (status.state === "preparing") reply.code(202).header("Retry-After", "1");
        return status;
      },
    });
  }
};
