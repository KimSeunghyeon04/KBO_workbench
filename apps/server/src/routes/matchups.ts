import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  MatchupQuerySchema,
  MatchupOpponentsQuerySchema,
  MatchupOpponentsResponseSchema,
  MatchupResponseSchema,
  DirectMatchupResponseSchema,
  MatchupModelResponseSchema,
} from "@kbo/contracts";
import {
  MatchupRepository,
  MatchupModelRepository,
  type MatchupModelWorkspace,
} from "@kbo/persistence";
import type { ComputationRunner } from "../computation.js";
import type { RouteContext } from "./context.js";
export const matchupRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & {
    models: Pick<MatchupModelWorkspace, "read">;
    computation: ComputationRunner;
  }
> = async (app, { pool, models, computation }) => {
  const repository = new MatchupRepository(pool);
  app.get(
    "/api/v2/analysis/matchups/opponents",
    {
      schema: {
        querystring: MatchupOpponentsQuerySchema,
        response: { 200: MatchupOpponentsResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.opponents(request.query),
  );
  app.get(
    "/api/v2/analysis/matchups/direct",
    {
      schema: {
        querystring: MatchupQuerySchema,
        response: { 200: DirectMatchupResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.direct(request.query),
  );
  app.get(
    "/api/v2/analysis/matchups",
    {
      schema: {
        querystring: MatchupQuerySchema,
        response: { 200: MatchupResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query),
  );
  const modeled = new MatchupModelRepository(pool);
  app.get(
    "/api/v2/analysis/matchups/model",
    {
      schema: {
        querystring: MatchupQuerySchema,
        response: { 200: MatchupModelResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const model = await models.read(request.query.season - 1),
        input = await modeled.read(request.query, model?.model ?? null, model?.hash ?? null),
        result = await computation.run({ kind: "matchup_summary", ...input });
      if (result.kind !== "matchup_summary") throw new Error("Unexpected matchup model response");
      return result.value;
    },
  );
};
