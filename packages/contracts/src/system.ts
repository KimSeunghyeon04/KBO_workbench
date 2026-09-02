import { type Static, Type } from "@sinclair/typebox";

import { ErrorCategorySchema } from "./collection.js";

const strictObjectOptions = { additionalProperties: false } as const;

export const FailureDiagnosticSchema = Type.Object(
  {
    jobId: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Union([Type.Literal("collection"), Type.Literal("import")]),
    gameId: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    category: ErrorCategorySchema,
    message: Type.String({ minLength: 1, maxLength: 2_000 }),
    occurredAt: Type.String({
      pattern:
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
    }),
  },
  strictObjectOptions,
);

export const HealthStatusSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("unavailable")]),
  },
  strictObjectOptions,
);

export const DatabaseStatusSchema = Type.Object(
  {
    reachable: Type.Boolean(),
    healthy: Type.Boolean(),
    serverMajorVersion: Type.Union([Type.Integer(), Type.Null()]),
    expectedServerMajorVersion: Type.Integer(),
    migrationVersion: Type.Union([Type.String(), Type.Null()]),
    expectedMigrationVersion: Type.String(),
    message: Type.String(),
  },
  strictObjectOptions,
);

export const WorkspaceStatusSchema = Type.Object(
  {
    writable: Type.Boolean(),
    path: Type.String(),
    message: Type.String(),
  },
  strictObjectOptions,
);

export const BrowserStatusSchema = Type.Object(
  {
    installed: Type.Boolean(),
    version: Type.Union([Type.String(), Type.Null()]),
    executablePath: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
  },
  strictObjectOptions,
);

export const SystemStatusSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("degraded")]),
    apiVersion: Type.String(),
    browser: BrowserStatusSchema,
    database: DatabaseStatusSchema,
    workspace: WorkspaceStatusSchema,
    recentFailures: Type.Array(FailureDiagnosticSchema, { maxItems: 20 }),
  },
  strictObjectOptions,
);

export const DashboardSummarySchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ready"), Type.Literal("degraded")]),
    counts: Type.Object(
      {
        collecting: Type.Integer({ minimum: 0 }),
        reviewRequired: Type.Integer({ minimum: 0 }),
        readyToImport: Type.Integer({ minimum: 0 }),
        stored: Type.Integer({ minimum: 0 }),
      },
      strictObjectOptions,
    ),
  },
  strictObjectOptions,
);

export type HealthStatus = Static<typeof HealthStatusSchema>;
export type DatabaseStatus = Static<typeof DatabaseStatusSchema>;
export type WorkspaceStatus = Static<typeof WorkspaceStatusSchema>;
export type BrowserStatus = Static<typeof BrowserStatusSchema>;
export type SystemStatus = Static<typeof SystemStatusSchema>;
export type FailureDiagnostic = Static<typeof FailureDiagnosticSchema>;
export type DashboardSummary = Static<typeof DashboardSummarySchema>;
