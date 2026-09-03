import {
  ApiErrorSchema,
  CorrectionCommandRequestSchema,
  CorrectionCommitRequestSchema,
  CorrectionCommitResultSchema,
  CorrectionGameCatalogSchema,
  CorrectionMutationResultSchema,
  CorrectionSessionCreateRequestSchema,
  CorrectionSessionSchema,
  CorrectionSourceEvidenceSchema,
  CorrectionVersionRequestSchema,
  StagingGameDocumentV2Schema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import type { RouteContext } from "./context.js";
import { parseCorrectionCommandRequest, sendCanonicalDocument } from "./http.js";
import {
  CorrectionDeleteQuerySchema,
  CorrectionSessionParamsSchema,
  CorrectionSourceEvidenceParamsSchema,
} from "./schemas.js";

export const correctionRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.get(
    "/api/v2/correction-games",
    { schema: { response: { 200: CorrectionGameCatalogSchema } } },
    async () => context.runtime.workspace.correctionGameCatalog(),
  );

  app.post(
    "/api/v2/correction-sessions",
    {
      schema: {
        body: CorrectionSessionCreateRequestSchema,
        response: { 201: CorrectionSessionSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await context.runtime.correctionSessions.create(request.body)),
  );

  app.get(
    "/api/v2/correction-sessions/:sessionId",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        response: { 200: CorrectionSessionSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => context.runtime.correctionSessions.get(request.params.sessionId),
  );

  app.get(
    "/api/v2/correction-sessions/:sessionId/original",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        response: { 200: StagingGameDocumentV2Schema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) =>
      sendCanonicalDocument(
        reply,
        await context.runtime.correctionSessions.original(request.params.sessionId),
      ),
  );

  app.get(
    "/api/v2/correction-sessions/:sessionId/source-evidence/:eventId",
    {
      schema: {
        params: CorrectionSourceEvidenceParamsSchema,
        response: { 200: CorrectionSourceEvidenceSchema, 404: ApiErrorSchema },
      },
    },
    async (request) =>
      context.runtime.correctionSessions.sourceEvidence(
        request.params.sessionId,
        request.params.eventId,
      ),
  );

  app.post(
    "/api/v2/correction-sessions/:sessionId/load-original",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        body: CorrectionVersionRequestSchema,
        response: {
          200: CorrectionMutationResultSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          422: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      context.runtime.correctionSessions.loadOriginal(
        request.params.sessionId,
        request.body.expectedSessionVersion,
      ),
  );

  app.post(
    "/api/v2/correction-sessions/:sessionId/commands",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        body: CorrectionCommandRequestSchema,
        response: {
          200: CorrectionMutationResultSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      context.runtime.correctionSessions.command(
        request.params.sessionId,
        request.body.expectedSessionVersion,
        parseCorrectionCommandRequest(request.body.command),
        request.body.apply,
      ),
  );

  for (const operation of ["undo", "redo"] as const) {
    app.post(
      `/api/v2/correction-sessions/:sessionId/${operation}`,
      {
        schema: {
          params: CorrectionSessionParamsSchema,
          body: CorrectionVersionRequestSchema,
          response: {
            200: CorrectionMutationResultSchema,
            404: ApiErrorSchema,
            409: ApiErrorSchema,
            422: ApiErrorSchema,
          },
        },
      },
      async (request) =>
        context.runtime.correctionSessions[operation](
          request.params.sessionId,
          request.body.expectedSessionVersion,
        ),
    );
  }

  app.post(
    "/api/v2/correction-sessions/:sessionId/commit",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        body: CorrectionCommitRequestSchema,
        response: {
          200: CorrectionCommitResultSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          422: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      context.runtime.correctionSessions.commit(request.params.sessionId, request.body),
  );

  app.delete(
    "/api/v2/correction-sessions/:sessionId",
    {
      schema: {
        params: CorrectionSessionParamsSchema,
        querystring: CorrectionDeleteQuerySchema,
        response: { 204: Type.Null(), 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      await context.runtime.correctionSessions.delete(
        request.params.sessionId,
        request.query.expectedSessionVersion,
      );
      return reply.code(204).send(null);
    },
  );
};
