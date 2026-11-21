import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { AnalysisSeasonsSchema } from "@kbo/contracts";
import type { AnalysisPreparationManager } from "../jobs/analysis-preparation-manager.js";

export const analysisPreparationRoutes: FastifyPluginAsyncTypebox<{
  preparation: Pick<AnalysisPreparationManager, "status">;
}> = async (app, { preparation }) => {
  app.get(
    "/api/v2/analysis/seasons",
    { schema: { response: { 200: AnalysisSeasonsSchema } } },
    () => preparation.status(),
  );
};
