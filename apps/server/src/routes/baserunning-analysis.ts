import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import {
  ApiErrorSchema,
  AnalysisScopeQuerySchema,
  BaserunningResponseSchema,
} from "@kbo/contracts";
import { BaserunningAnalysisRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const baserunningAnalysisRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool">
> = async (app, { pool }) => {
  const repository = new BaserunningAnalysisRepository(pool),
    response = { 200: BaserunningResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema };
  app.get(
    "/api/v2/analysis/baserunning",
    { schema: { querystring: AnalysisScopeQuerySchema, response } },
    (request) => repository.read(request.query),
  );
  app.get(
    "/api/v2/analysis/baserunning/:playerId",
    {
      schema: {
        params: Type.Object(
          { playerId: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        querystring: AnalysisScopeQuerySchema,
        response,
      },
    },
    (request) => repository.read(request.query, request.params.playerId),
  );
};
