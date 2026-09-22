import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  ApiErrorSchema,
  AnalysisScopeQuerySchema,
  PitchAnalysisPitcherParamsSchema,
  PitchAnglesResponseSchema,
} from "@kbo/contracts";
import { PitchAnglesRepository } from "@kbo/persistence";
import type { RouteContext } from "./context.js";
import type { ComputationRunner } from "../computation.js";
export const pitchAnglesRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & { computation: ComputationRunner }
> = async (app, { pool, computation }) => {
  const repository = new PitchAnglesRepository(pool);
  app.get(
    "/api/v2/analysis/pitch-angles/:pitcherId",
    {
      schema: {
        params: PitchAnalysisPitcherParamsSchema,
        querystring: AnalysisScopeQuerySchema,
        response: { 200: PitchAnglesResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const input = await repository.read(request.query, request.params.pitcherId),
        result = await computation.run({ kind: "pitch_angles", ...input });
      if (result.kind !== "pitch_angles") throw new Error("Unexpected pitch angles result");
      return result.value;
    },
  );
};
