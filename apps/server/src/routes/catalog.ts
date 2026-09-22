import {
  ApiErrorSchema,
  compareCanonicalStrings,
  GameCatalogSchema,
  StagingGameDocumentV2Schema,
  DatabaseGamesSchema,
  DatabaseGamesQuerySchema,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import type { RouteContext } from "./context.js";
import { apiError, sendCanonicalDocument } from "./http.js";
import { GameParamsSchema, GamesQuerySchema } from "./schemas.js";

export const catalogRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.get(
    "/api/v2/database/games",
    {
      schema: { querystring: DatabaseGamesQuerySchema, response: { 200: DatabaseGamesSchema } },
    },
    async (request) => {
      const query = request.query;
      if (query.authority === "database") {
        const [page, workspace] = await Promise.all([
          context.runtime.revisionStore.catalogPage(query),
          context.runtime.workspace.catalog(),
        ]);
        return {
          ...page,
          seasons: [
            ...new Set([
              ...page.seasons,
              ...workspace.games.flatMap((game) => (game.season === null ? [] : [game.season])),
            ]),
          ].sort((a, b) => b - a),
        };
      }
      const [workspace, stored] = await Promise.all([
        context.runtime.workspace.catalog(),
        context.runtime.revisionStore.catalogSeasons(),
      ]);
      const all = workspace.games;
      const search = (query.search ?? "").trim().toLocaleLowerCase("ko-KR");
      const filtered = all
        .filter(
          (game) =>
            game.authority === query.authority &&
            (query.season === undefined || game.season === query.season) &&
            `${game.gameId} ${"gameDate" in game ? game.gameDate : ""} ${"teams" in game ? `${game.teams.away.name} ${game.teams.home.name}` : ""}`
              .toLocaleLowerCase("ko-KR")
              .includes(search),
        )
        .sort(
          (a, b) =>
            compareCanonicalStrings(
              "gameDate" in b ? b.gameDate : b.updatedAt,
              "gameDate" in a ? a.gameDate : a.updatedAt,
            ) || compareCanonicalStrings(a.gameId, b.gameId),
        );
      const page = query.page ?? 1,
        limit = query.limit ?? 50;
      return {
        games: filtered.slice((page - 1) * limit, page * limit),
        total: filtered.length,
        page,
        limit,
        seasons: [
          ...new Set([
            ...stored,
            ...all.flatMap((game) => (game.season === null ? [] : [game.season])),
          ]),
        ].sort((a, b) => b - a),
      };
    },
  );
  app.get(
    "/api/v2/games",
    { schema: { querystring: GamesQuerySchema, response: { 200: GameCatalogSchema } } },
    async (request) => {
      const [workspaceCatalog, storedCatalog] = await Promise.all([
        request.query.authority === "database"
          ? Promise.resolve({ games: [] })
          : context.runtime.workspace.catalog(),
        request.query.authority === undefined || request.query.authority === "database"
          ? context.runtime.revisionStore.catalog()
          : Promise.resolve([]),
      ]);
      const catalog = {
        games: [...workspaceCatalog.games, ...storedCatalog].sort((left, right) =>
          compareCanonicalStrings(right.updatedAt, left.updatedAt),
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
      const current = await context.runtime.workspace.readCurrentDocumentSnapshot(
        request.params.gameId,
      );
      if (current === null) {
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
      return sendCanonicalDocument(reply, current.document);
    },
  );
};
