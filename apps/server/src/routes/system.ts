import {
  DatabaseOverviewSchema,
  compareCanonicalStrings,
  DashboardSummarySchema,
  HealthStatusSchema,
  SystemStatusSchema,
  type FailureDiagnostic,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { inspectDatabase } from "../database.js";
import { buildSystemStatus } from "../status.js";
import type { RouteContext } from "./context.js";

export const systemRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  app.get("/health/live", { schema: { response: { 200: HealthStatusSchema } } }, async () => ({
    status: "ok" as const,
  }));

  app.get(
    "/health/ready",
    { schema: { response: { 200: HealthStatusSchema, 503: HealthStatusSchema } } },
    async (_request, reply) => {
      const status = await buildSystemStatus(context.config, context.pool);
      if (status.status !== "ready") return reply.code(503).send({ status: "unavailable" });
      return { status: "ok" as const };
    },
  );

  app.get(
    "/api/v2/system/status",
    { schema: { response: { 200: SystemStatusSchema } } },
    async () => buildSystemStatus(context.config, context.pool, recentFailures(context.runtime)),
  );

  app.get(
    "/api/v2/database/status",
    { schema: { response: { 200: DatabaseOverviewSchema } } },
    async () => {
      const [database, workspaceCatalog] = await Promise.all([
        inspectDatabase(context.pool, context.config.expectedMigrationVersion),
        context.runtime.workspace.catalog(),
      ]);
      if (!database.healthy) {
        return {
          database,
          counts: {
            readyToImport: workspaceCatalog.games.filter((game) => game.authority === "staging")
              .length,
            stored: 0,
          },
        };
      }
      const storedCatalog = await context.runtime.revisionStore.catalog();
      const storedIds = new Set(storedCatalog.map((game) => game.gameId));
      return {
        database,
        counts: {
          readyToImport: workspaceCatalog.games.filter(
            (game) => game.authority === "staging" && !storedIds.has(game.gameId),
          ).length,
          stored: storedCatalog.length,
        },
      };
    },
  );

  app.get(
    "/api/v2/dashboard",
    { schema: { response: { 200: DashboardSummarySchema } } },
    async () => {
      const system = await buildSystemStatus(context.config, context.pool);
      const [catalog, storedCatalog] = await Promise.all([
        context.runtime.workspace.catalog(),
        context.runtime.revisionStore.catalog(),
      ]);
      const storedIds = new Set(storedCatalog.map((game) => game.gameId));
      const jobs = context.runtime.collectionJobs.list();
      return {
        status: system.status,
        counts: {
          collecting: jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status))
            .length,
          reviewRequired: catalog.games.filter(
            (game) => game.authority === "quarantine" || game.authority === "source_failure",
          ).length,
          readyToImport: catalog.games.filter(
            (game) => game.authority === "staging" && !storedIds.has(game.gameId),
          ).length,
          stored: storedCatalog.length,
        },
      };
    },
  );
};

function recentFailures(runtime: RouteContext["runtime"]): FailureDiagnostic[] {
  return [
    ...runtime.collectionJobs
      .list()
      .filter(
        (job) =>
          job.status === "failed" &&
          job.error !== null &&
          job.errorCategory !== null &&
          job.finishedAt !== null,
      )
      .map((job) => ({
        jobId: job.jobId,
        kind: "collection" as const,
        gameId: job.currentGameId,
        category: job.errorCategory ?? "source",
        message: job.error ?? "수집 작업이 실패했습니다.",
        occurredAt: job.finishedAt ?? job.createdAt,
      })),
    ...runtime.importJobs
      .list()
      .filter(
        (job) =>
          job.status === "failed" &&
          job.error !== null &&
          job.errorCategory !== null &&
          job.finishedAt !== null,
      )
      .map((job) => ({
        jobId: job.jobId,
        kind: "import" as const,
        gameId: job.gameId,
        category: job.errorCategory ?? "persistence",
        message: job.error ?? "적재 작업이 실패했습니다.",
        occurredAt: job.finishedAt ?? job.createdAt,
      })),
  ]
    .sort((left, right) => compareCanonicalStrings(right.occurredAt, left.occurredAt))
    .slice(0, 10);
}
