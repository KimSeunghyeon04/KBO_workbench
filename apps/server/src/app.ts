import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance, type FastifyServerFactory } from "fastify";
import type { Pool } from "pg";
import { BatterStrikeZoneRepository } from "@kbo/persistence";

import type { AppConfig } from "./config.js";
import { installHttpErrorHandler } from "./http-error-handler.js";
import { installLocalRequestBoundary } from "./local-request-boundary.js";
import { ReplayService } from "./replay-service.js";
import { catalogRoutes } from "./routes/catalog.js";
import { collectionRoutes } from "./routes/collection.js";
import { collectionOperationsRoutes } from "./routes/collection-operations.js";
import { correctionRoutes } from "./routes/correction.js";
import { importRoutes } from "./routes/import.js";
import { replayRoutes } from "./routes/replay.js";
import { analysisRoutes } from "./routes/analysis.js";
import { analysisModelRoutes } from "./routes/analysis-models.js";
import { recordCorrectionRoutes } from "./routes/record-correction.js";
import { systemRoutes } from "./routes/system.js";
import type { AppRuntime } from "./runtime.js";

export function createApp(
  config: AppConfig,
  pool: Pool,
  runtime: AppRuntime,
  serverFactory?: FastifyServerFactory,
): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL?.trim() || "info" },
    trustProxy: false,
    ...(serverFactory === undefined ? {} : { serverFactory }),
  }).withTypeProvider<TypeBoxTypeProvider>();
  const context = {
    config,
    pool,
    runtime,
    replayService: new ReplayService(runtime.revisionStore, (gameId, revision) =>
      new BatterStrikeZoneRepository(pool).forGame(gameId, revision),
    ),
  };

  installHttpErrorHandler(app);
  installLocalRequestBoundary(app);

  app.register(systemRoutes, context);
  app.register(catalogRoutes, context);
  app.register(collectionRoutes, context);
  app.register(collectionOperationsRoutes, context);
  app.register(correctionRoutes, context);
  app.register(importRoutes, context);
  app.register(replayRoutes, context);
  app.register(analysisRoutes, {
    pool: context.pool,
    references: context.runtime.workspace.pitchReferences,
    calibrations: context.runtime.workspace.pitchCalibrations,
    summaries: context.runtime.workspace.analysisCoverage,
    runModels: context.runtime.workspace.runExpectancy,
    parkModels: context.runtime.workspace.parkEnvironment,
    qualityModels: context.runtime.workspace.pitchQuality,
    matchupModels: context.runtime.workspace.matchupModels,
  });
  app.register(recordCorrectionRoutes, context);
  if (runtime.analysisModelJobs !== undefined)
    app.register(analysisModelRoutes, { jobs: runtime.analysisModelJobs });

  app.addHook("onClose", async () => {
    context.replayService.close();
    await runtime.close();
    await pool.end();
  });
  return app;
}
