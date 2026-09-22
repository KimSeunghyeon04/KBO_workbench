import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  ApiErrorSchema,
  RunValueResponseSchema,
  CountRunValueResponseSchema,
  WinProbabilityResponseSchema,
} from "@kbo/contracts";
import { RunValueRepository, type RunExpectancyWorkspace } from "@kbo/persistence";
import { apiError } from "./http.js";
import type { RouteContext } from "./context.js";
export const runValueRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & {
    models: Pick<RunExpectancyWorkspace, "read" | "readCount" | "readWin">;
  }
> = async (app, { pool, models }) => {
  const repository = new RunValueRepository(pool);
  app.get(
    "/api/v2/analysis/win-probability/games/:gameId",
    {
      schema: {
        params: Type.Object(
          { gameId: Type.String({ minLength: 1, maxLength: 100 }) },
          { additionalProperties: false },
        ),
        querystring: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            season: Type.Integer({ minimum: 1982, maximum: 2200 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: WinProbabilityResponseSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const model = await models.readWin(request.query.season - 1),
        result = await repository.winGame(
          request.params.gameId,
          request.query.revision,
          model?.model ?? null,
          model?.hash ?? null,
          request.query.season,
        );
      return result === null
        ? reply
            .code(404)
            .send(
              apiError(
                request.id,
                "game_not_found",
                "persistence",
                "봉인된 경기 revision을 찾을 수 없습니다.",
                false,
              ),
            )
        : result;
    },
  );
  app.get(
    "/api/v2/analysis/count-run-value/games/:gameId",
    {
      schema: {
        params: Type.Object(
          { gameId: Type.String({ minLength: 1, maxLength: 100 }) },
          { additionalProperties: false },
        ),
        querystring: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            season: Type.Integer({ minimum: 1982, maximum: 2200 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: CountRunValueResponseSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const model = await models.readCount(request.query.season - 1),
        result = await repository.countGame(
          request.params.gameId,
          request.query.revision,
          model?.model ?? null,
          model?.hash ?? null,
          request.query.season,
        );
      return result === null
        ? reply
            .code(404)
            .send(
              apiError(
                request.id,
                "game_not_found",
                "persistence",
                "봉인된 경기 revision을 찾을 수 없습니다.",
                false,
              ),
            )
        : result;
    },
  );
  app.get(
    "/api/v2/analysis/run-value/games/:gameId",
    {
      schema: {
        params: Type.Object(
          { gameId: Type.String({ minLength: 1, maxLength: 100 }) },
          { additionalProperties: false },
        ),
        querystring: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            season: Type.Integer({ minimum: 1982, maximum: 2200 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: RunValueResponseSchema,
          400: ApiErrorSchema,
          404: ApiErrorSchema,
          500: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const model = await models.read(request.query.season - 1),
        result = await repository.game(
          request.params.gameId,
          request.query.revision,
          model?.model ?? null,
          model?.hash ?? null,
          request.query.season,
        );
      return result === null
        ? reply
            .code(404)
            .send(
              apiError(
                request.id,
                "game_not_found",
                "persistence",
                "봉인된 경기 revision을 찾을 수 없습니다.",
                false,
              ),
            )
        : result;
    },
  );
};
