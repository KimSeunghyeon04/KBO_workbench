import {
  ApiErrorSchema,
  ImportJobCreateRequestSchema,
  ImportJobCreatedSchema,
  ImportJobListSchema,
  ImportJobSchema,
  ImportReadyBatchCreatedSchema,
  ImportReadyBatchCreateRequestSchema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { RouteContext } from "./context.js";
import { JobParamsSchema } from "./schemas.js";

export const importRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.post(
    "/api/v2/import-jobs",
    {
      schema: {
        body: ImportJobCreateRequestSchema,
        response: {
          202: ImportJobCreatedSchema,
          400: ApiErrorSchema,
          409: ApiErrorSchema,
          422: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = context.runtime.importJobs.create(request.body);
      return reply.code(202).send({ jobId: job.jobId, status: job.status });
    },
  );

  app.get(
    "/api/v2/import-jobs",
    { schema: { response: { 200: ImportJobListSchema } } },
    async () => ({ jobs: [...context.runtime.importJobs.list()] }),
  );

  app.post(
    "/api/v2/import-jobs/batch",
    {
      schema: {
        body: ImportReadyBatchCreateRequestSchema,
        response: {
          202: ImportReadyBatchCreatedSchema,
          400: ApiErrorSchema,
          409: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const batch = await context.runtime.importJobs.createReadyBatch(request.body);
      return reply.code(202).send(batch);
    },
  );

  app.get(
    "/api/v2/import-jobs/:jobId",
    {
      schema: {
        params: JobParamsSchema,
        response: { 200: ImportJobSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => context.runtime.importJobs.get(request.params.jobId),
  );
};
