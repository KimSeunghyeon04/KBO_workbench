import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  AnalysisScopeQuerySchema,
  ParkEnvironmentResponseSchema,
  ApiErrorSchema,
} from "@kbo/contracts";
import { ParkEnvironmentRepository, type ParkEnvironmentWorkspace } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
export const parkEnvironmentRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { models: Pick<ParkEnvironmentWorkspace, "read"> }
> = async (app, { pool, models }) => {
  const repository = new ParkEnvironmentRepository(pool);
  app.get(
    "/api/v2/analysis/park-environment",
    {
      schema: {
        querystring: AnalysisScopeQuerySchema,
        response: { 200: ParkEnvironmentResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const model = await models.read(request.query.season - 1);
      return repository.read(request.query, model?.model ?? null, model?.hash ?? null);
    },
  );
};
