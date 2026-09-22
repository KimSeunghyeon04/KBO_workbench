import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  AnalysisScopeQuerySchema,
  DisciplineCatalogSchema,
  DisciplineParamsSchema,
  DisciplineQuerySchema,
  DisciplineResponseSchema,
} from "@kbo/contracts";
import {
  BatterDisciplineRepository,
  type PitchReferenceWorkspace,
  type PitchAnalysisComputation,
} from "@kbo/persistence";
import type { RouteContext } from "./context.js";
import { BatterDisciplineService } from "../batter-discipline-service.js";

type Options = Pick<RouteContext, "pool"> & {
  references: Pick<PitchReferenceWorkspace, "getOrCreate">;
  computeReference?: PitchAnalysisComputation["reference"];
};
export const batterDisciplineRoutes: FastifyPluginAsyncTypebox<Options> = async (app, context) => {
  const repository = new BatterDisciplineRepository(
    context.pool,
    context.references,
    context.computeReference,
  );
  const service = new BatterDisciplineService(repository);
  app.addHook("onClose", async () => service.close());
  app.get(
    "/api/v2/analysis/batter-discipline",
    {
      schema: {
        querystring: AnalysisScopeQuerySchema,
        response: { 200: DisciplineCatalogSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const { season, ...scope } = request.query;
      return repository.catalog(season, scope);
    },
  );
  app.get(
    "/api/v2/analysis/batter-discipline/:batterId",
    {
      schema: {
        params: DisciplineParamsSchema,
        querystring: DisciplineQuerySchema,
        response: {
          200: DisciplineResponseSchema,
          400: ApiErrorSchema,
          500: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request) => service.analyze({ ...request.query }, request.params.batterId),
  );
};
