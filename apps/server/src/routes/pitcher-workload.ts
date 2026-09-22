import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ApiErrorSchema,
  AnalysisScopeQuerySchema,
  PitcherWorkloadResponseSchema,
  PitchAnalysisPitcherParamsSchema,
  WorkloadComparisonResponseSchema,
  InvalidAnalysisScopeError,
} from "@kbo/contracts";
import { PitcherWorkloadRepository, WorkloadComparisonRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
import type { ComputationRunner } from "../computation.js";
export const pitcherWorkloadRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { computation: ComputationRunner }
> = async (app, { pool, computation }) => {
  const repository = new PitcherWorkloadRepository(pool);
  const comparison = new WorkloadComparisonRepository(pool);
  app.get(
    "/api/v2/analysis/pitcher-workload/:pitcherId/comparison",
    {
      preValidation: async (request) => {
        // Validate the original query before Fastify can remove unknown properties.
        if (
          !Value.Check(
            AnalysisScopeQuerySchema,
            Value.Convert(AnalysisScopeQuerySchema, request.query),
          )
        )
          throw new InvalidAnalysisScopeError("투수 운용 비교 조회 조건이 올바르지 않습니다.");
      },
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: AnalysisScopeQuerySchema,
        response: {
          200: WorkloadComparisonResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const controller = new AbortController();
      const cancel = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      request.raw.once("aborted", cancel);
      reply.raw.once("close", cancel);
      try {
        const input = await comparison.read(request.query, request.params.pitcherId);
        controller.signal.throwIfAborted();
        const result = await computation.run(
          { kind: "workload_comparison", ...input },
          controller.signal,
        );
        if (result.kind !== "workload_comparison")
          throw new Error("Unexpected workload comparison result");
        return result.value;
      } finally {
        request.raw.off("aborted", cancel);
        reply.raw.off("close", cancel);
      }
    },
  );
  app.get(
    "/api/v2/analysis/pitcher-workload/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: AnalysisScopeQuerySchema,
        response: { 200: PitcherWorkloadResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.pitcherId),
  );
};
