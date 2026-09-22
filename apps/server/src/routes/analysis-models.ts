import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  AnalysisModelJobIdSchema,
  AnalysisModelJobSchema,
  AnalysisModelRefreshSchema,
  AnalysisModelPolicySchema,
  AnalysisModelManagementSchema,
  AnalysisModelSeasonSchema,
  AnalysisModelPolicyUpdateSchema,
  ApiErrorSchema,
} from "@kbo/contracts";
import type { AnalysisModelJobManager } from "../jobs/analysis-model-job-manager.js";
const params = Type.Object({ id: AnalysisModelJobIdSchema }, { additionalProperties: false });
const errors = {
  400: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  500: ApiErrorSchema,
};
export const analysisModelRoutes: FastifyPluginAsyncTypebox<{
  jobs: Pick<AnalysisModelJobManager, "status" | "create" | "get" | "cancel" | "setPolicy">;
}> = async (app, { jobs }) => {
  app.get(
    "/api/v2/analysis/models",
    {
      schema: {
        querystring: Type.Object(
          { season: Type.Optional(AnalysisModelSeasonSchema) },
          { additionalProperties: false },
        ),
        response: { 200: AnalysisModelManagementSchema, ...errors },
      },
    },
    (request) => jobs.status(request.query.season ?? 2025),
  );
  app.post(
    "/api/v2/analysis/model-jobs",
    {
      schema: {
        body: AnalysisModelRefreshSchema,
        response: { 202: AnalysisModelJobSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await jobs.create(
            request.body.requestId,
            request.body.force,
            request.body.applicationSeason,
          ),
        ),
  );
  app.get(
    "/api/v2/analysis/model-jobs/:id",
    { schema: { params, response: { 200: AnalysisModelJobSchema, ...errors } } },
    (request) => jobs.get(request.params.id),
  );
  app.post(
    "/api/v2/analysis/model-jobs/:id/cancel",
    { schema: { params, response: { 200: AnalysisModelJobSchema, ...errors } } },
    (request) => jobs.cancel(request.params.id),
  );
  app.put(
    "/api/v2/analysis/model-policy",
    {
      schema: {
        body: AnalysisModelPolicyUpdateSchema,
        response: { 200: AnalysisModelPolicySchema, ...errors },
      },
    },
    (request) => jobs.setPolicy(request.body.enabled, request.body.applicationSeason),
  );
};
