import {
  DatabaseOverviewSchema,
  compareCanonicalStrings,
  DashboardSummarySchema,
  HealthStatusSchema,
  SystemStatusSchema,
  type FailureDiagnostic,
} from "@kbo/contracts";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

import { buildSystemStatus, createSystemStatusReader } from "../status.js";
import type { RouteContext } from "./context.js";

export const systemRoutes: FastifyPluginAsyncTypebox<RouteContext> = async (app, context) => {
  const readStatus = createSystemStatusReader(() =>
    buildSystemStatus(context.config, context.pool),
  );
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
    async () => ({ ...(await readStatus()), recentFailures: recentFailures(context.runtime) }),
  );

  app.get(
    "/api/v2/database/status",
    { schema: { response: { 200: DatabaseOverviewSchema } } },
    async () => {
      const [database, workspaceCatalog] = await Promise.all([
        readStatus().then((status) => status.database),
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
      const storedIds = new Set(await context.runtime.revisionStore.storedGameIds());
      return {
        database,
        counts: {
          readyToImport: workspaceCatalog.games.filter(
            (game) => game.authority === "staging" && !storedIds.has(game.gameId),
          ).length,
          stored: storedIds.size,
        },
      };
    },
  );

  app.get(
    "/api/v2/dashboard",
    { schema: { response: { 200: DashboardSummarySchema } } },
    async () => {
      const [system, catalog, storedGameIds] = await Promise.all([
        readStatus(),
        context.runtime.workspace.catalog(),
        context.runtime.revisionStore.storedGameIds(),
      ]);
      const storedIds = new Set(storedGameIds);
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
          stored: storedIds.size,
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
