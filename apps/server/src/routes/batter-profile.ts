import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  PitchOutcomeQuerySchema,
  BatterProfileResponseSchema,
  DisciplineParamsSchema,
} from "@kbo/contracts";
import { BatterProfileRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const batterProfileRoutes: FastifyPluginAsyncTypebox<Pick<RouteContext, "pool">> = async (
  app,
  context,
) => {
  const repository = new BatterProfileRepository(context.pool);
  app.get(
    "/api/v2/analysis/batter-profile/:batterId",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: PitchOutcomeQuerySchema,
        response: { 200: BatterProfileResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    (request) => repository.analyze(request.query, request.params.batterId),
  );
};
