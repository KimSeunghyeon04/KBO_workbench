import {
  ApiErrorSchema,
  ReplayFramePageSchema,
  ReplayFramesQuerySchema,
  ReplayManifestSchema,
  RevisionCatalogSchema,
  StagingGameDocumentV2Schema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import type { RouteContext } from "./context.js";
import { sendCanonicalDocument } from "./http.js";
import { GameParamsSchema, RevisionParamsSchema } from "./schemas.js";
import { storedCompilerFindings } from "../source-projection.js";

export const replayRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.get(
    "/api/v2/games/:gameId/revisions",
    {
      schema: {
        params: GameParamsSchema,
        response: { 200: RevisionCatalogSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => context.runtime.revisionStore.revisions(request.params.gameId),
  );

  app.post(
    "/api/v2/games/:gameId/revisions/:revision/correction-drafts",
    {
      schema: {
        params: RevisionParamsSchema,
        response: {
          201: StagingGameDocumentV2Schema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const document = await context.runtime.revisionStore.loadCorrectionDraft(
        request.params.gameId,
        request.params.revision,
      );
      const replay = compileStagingGameDocumentV2(document);
      const findings = storedCompilerFindings(replay.findings);
      if (replay.findings.some((finding) => finding.severity === "blocking")) {
        await context.runtime.workspace.saveQuarantine(document, findings);
      } else {
        await context.runtime.workspace.saveReady(document, findings);
      }
      reply.code(201);
      return sendCanonicalDocument(reply, document);
    },
  );

  app.get(
    "/api/v2/games/:gameId/revisions/:revision/replay-manifest",
    {
      schema: {
        params: RevisionParamsSchema,
        response: { 200: ReplayManifestSchema, 404: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) =>
      context.replayService.manifest(request.params.gameId, request.params.revision),
  );

  app.get(
    "/api/v2/games/:gameId/revisions/:revision/replay-frames",
    {
      schema: {
        params: RevisionParamsSchema,
        querystring: ReplayFramesQuerySchema,
        response: {
          200: ReplayFramePageSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      context.replayService.frames(
        request.params.gameId,
        request.params.revision,
        request.query.cursor,
        request.query.limit,
      ),
  );
};
