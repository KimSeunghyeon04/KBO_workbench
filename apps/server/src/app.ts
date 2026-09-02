import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "./config.js";
import { installHttpErrorHandler } from "./http-error-handler.js";
import { installLocalRequestBoundary } from "./local-request-boundary.js";
import { ReplayService } from "./replay-service.js";
import { catalogRoutes } from "./routes/catalog.js";
import { collectionRoutes } from "./routes/collection.js";
import { correctionRoutes } from "./routes/correction.js";
import { importRoutes } from "./routes/import.js";
import { replayRoutes } from "./routes/replay.js";
import { recordCorrectionRoutes } from "./routes/record-correction.js";
import { systemRoutes } from "./routes/system.js";
import type { AppRuntime } from "./runtime.js";

export function createApp(config: AppConfig, pool: Pool, runtime: AppRuntime): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL?.trim() || "info" },
    trustProxy: false,
  }).withTypeProvider<TypeBoxTypeProvider>();
  const context = {
    config,
    pool,
    runtime,
    replayService: new ReplayService(runtime.revisionStore),
  };

  installHttpErrorHandler(app);
  installLocalRequestBoundary(app);

  app.register(systemRoutes, context);
  app.register(catalogRoutes, context);
  app.register(collectionRoutes, context);
  app.register(correctionRoutes, context);
  app.register(importRoutes, context);
  app.register(replayRoutes, context);
  app.register(recordCorrectionRoutes, context);

  app.addHook("onClose", async () => {
    await runtime.close();
    await pool.end();
  });
  return app;
}
