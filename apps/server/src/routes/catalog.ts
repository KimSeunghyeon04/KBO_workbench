import { ApiErrorSchema, GameCatalogSchema, StagingGameDocumentV2Schema } from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { RouteContext } from "./context.js";
import { apiError, sendCanonicalDocument } from "./http.js";
import { GameParamsSchema, GamesQuerySchema } from "./schemas.js";

export const catalogRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.get(
    "/api/v2/games",
    { schema: { querystring: GamesQuerySchema, response: { 200: GameCatalogSchema } } },
    async (request) => {
      const [workspaceCatalog, storedCatalog] = await Promise.all([
        context.runtime.workspace.catalog(),
        context.runtime.revisionStore.catalog(),
      ]);
      const catalog = {
        games: [...workspaceCatalog.games, ...storedCatalog].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
      };
      return request.query.authority === undefined
        ? catalog
        : { games: catalog.games.filter((game) => game.authority === request.query.authority) };
    },
  );

  app.get(
    "/api/v2/games/:gameId",
    {
      schema: {
        params: GameParamsSchema,
        response: { 200: StagingGameDocumentV2Schema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const workspaceCatalog = await context.runtime.workspace.catalog();
      const item = workspaceCatalog.games.find(
        (game) => game.gameId === request.params.gameId && game.authority !== "source_failure",
      );
      if (
        item === undefined ||
        item.season === null ||
        item.authority === "source_failure" ||
        item.authority === "database"
      ) {
        return reply
          .code(404)
          .send(
            apiError(
              request.id,
              "game_not_found",
              "domain",
              "경기 문서를 찾을 수 없습니다.",
              false,
            ),
          );
      }
      return sendCanonicalDocument(
        reply,
        await context.runtime.workspace.readDocument(item.authority, item.season, item.gameId),
      );
    },
  );
};
