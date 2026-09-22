import {
  ApiErrorSchema,
  ImportJobCreateRequestSchema,
  ImportJobCreatedSchema,
  ImportJobListSchema,
  ImportJobSchema,
  ImportReadyBatchCreatedSchema,
  ImportReadyBatchCreateRequestSchema,
  ImportSelectionRequestSchema,
  ImportSelectionSchema,
  ImportHistoryQuerySchema,
  ImportHistorySchema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { RouteContext } from "./context.js";
import { JobParamsSchema } from "./schemas.js";
import { Type } from "@sinclair/typebox";

export const importRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.post(
    "/api/v2/import-selections",
    {
      schema: {
        body: ImportSelectionRequestSchema,
        response: { 201: ImportSelectionSchema, 422: ApiErrorSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await context.runtime.importJobs.createSelection(request.body)),
  );
  app.get(
    "/api/v2/import-history",
    {
      schema: { querystring: ImportHistoryQuerySchema, response: { 200: ImportHistorySchema } },
    },
    async (request) => context.runtime.importJobs.history(request.query),
  );
  app.post(
    "/api/v2/import-jobs/:jobId/cancel",
    {
      schema: { params: JobParamsSchema, response: { 200: ImportJobSchema, 404: ApiErrorSchema } },
    },
    async (request) => context.runtime.importJobs.cancel(request.params.jobId),
  );
  app.post(
    "/api/v2/import-jobs/:jobId/reconcile",
    {
      schema: { params: JobParamsSchema, response: { 200: ImportJobSchema, 404: ApiErrorSchema } },
    },
    async (request) => context.runtime.importJobs.reconcile(request.params.jobId),
  );
  app.post(
    "/api/v2/import-batches/:batchId/cancel",
    {
      schema: {
        params: Type.Object(
          { batchId: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ cancelled: Type.Boolean() }, { additionalProperties: false }),
        },
      },
    },
    async (request) => {
      await context.runtime.importJobs.cancelBatch(request.params.batchId);
      return { cancelled: true };
    },
  );
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
      const job = await context.runtime.importJobs.create(request.body);
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
