import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import {
  AnalysisScopeQuerySchema,
  PitchQualityResponseSchema,
  ApiErrorSchema,
} from "@kbo/contracts";
import { PitchQualityRepository, type PitchQualityWorkspace } from "@kbo/persistence";
import type { ComputationRunner } from "../computation.js";
import type { RouteContext } from "./context.js";
export const pitchQualityRoutes: FastifyPluginAsyncTypebox<
  Pick<RouteContext, "pool"> & {
    models: Pick<PitchQualityWorkspace, "read">;
    computation: ComputationRunner;
  }
> = async (app, { pool, models, computation }) => {
  const repository = new PitchQualityRepository(pool);
  app.get(
    "/api/v2/analysis/pitch-quality/:pitcherId",
    {
      schema: {
        params: Type.Object(
          { pitcherId: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
        querystring: AnalysisScopeQuerySchema,
        response: { 200: PitchQualityResponseSchema, 400: ApiErrorSchema, 500: ApiErrorSchema },
      },
    },
    async (request) => {
      const model = await models.read(request.query.season - 1),
        input = await repository.read(
          request.query,
          request.params.pitcherId,
          model?.model ?? null,
          model?.hash ?? null,
        );
      const result = await computation.run({ kind: "pitch_quality_summary", ...input });
      if (result.kind !== "pitch_quality_summary")
        throw new Error("Unexpected pitch quality response");
      return result.value;
    },
  );
};
