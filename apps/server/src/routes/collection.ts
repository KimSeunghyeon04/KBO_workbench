import {
  ApiErrorSchema,
  CollectionJobCreateRequestSchema,
  CollectionJobCreatedSchema,
  CollectionJobListSchema,
  CollectionJobSchema,
  type JobEvent,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { RouteContext } from "./context.js";
import { JobParamsSchema } from "./schemas.js";

export const collectionRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.post(
    "/api/v2/collection-jobs",
    {
      schema: {
        body: CollectionJobCreateRequestSchema,
        response: {
          202: CollectionJobCreatedSchema,
          400: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const job = await context.runtime.collectionJobs.create(request.body);
      return reply.code(202).send({ jobId: job.jobId, status: job.status });
    },
  );

  app.get(
    "/api/v2/collection-jobs",
    {
      schema: {
        querystring: Type.Object(
          { activeOnly: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: { 200: CollectionJobListSchema },
      },
    },
    async (request) => ({
      jobs: [...context.runtime.collectionJobs.list()].filter(
        (job) => request.query.activeOnly !== true || !isTerminal(job.status),
      ),
    }),
  );

  app.get(
    "/api/v2/collection-jobs/:jobId",
    {
      schema: {
        params: JobParamsSchema,
        response: { 200: CollectionJobSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => context.runtime.collectionJobs.get(request.params.jobId),
  );

  app.delete(
    "/api/v2/collection-jobs/:jobId",
    {
      schema: {
        params: JobParamsSchema,
        response: { 200: CollectionJobSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => context.runtime.collectionJobs.cancel(request.params.jobId),
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/v2/collection-jobs/:jobId/events",
    { schema: { params: JobParamsSchema } },
    async (request, reply) => {
      const lastEventId = headerText(request.headers["last-event-id"]);
      const initial = context.runtime.collectionJobs.eventsAfter(request.params.jobId, lastEventId);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();
      for (const event of initial) writeServerSentEvent(reply.raw, event);
      if (isTerminal(context.runtime.collectionJobs.get(request.params.jobId).status)) {
        reply.raw.end();
        return;
      }
      const unsubscribe = context.runtime.collectionJobs.subscribe(
        request.params.jobId,
        (event) => {
          writeServerSentEvent(reply.raw, event);
          if (isTerminal(event.type)) {
            cleanup();
            reply.raw.end();
          }
        },
      );
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.once("close", cleanup);
    },
  );
};

function headerText(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function isTerminal(status: string): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}

function writeServerSentEvent(response: import("node:http").ServerResponse, event: JobEvent): void {
  response.write(`id: ${event.eventId}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
