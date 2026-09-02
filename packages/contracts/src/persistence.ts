import { type Static, Type } from "@sinclair/typebox";

import { ApiErrorSchema, ErrorCategorySchema, JobStatusSchema } from "./collection.js";
import { DatabaseStatusSchema } from "./system.js";

const strict = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const GameIdSchema = Type.String({
  pattern: "^[A-Za-z0-9_-]+$",
  minLength: 1,
  maxLength: 100,
});
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});

export const ImportJobCreateRequestSchema = Type.Object(
  {
    gameId: GameIdSchema,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  },
  strict,
);

export const ImportJobSchema = Type.Object(
  {
    jobId: IdSchema,
    kind: Type.Literal("import"),
    status: JobStatusSchema,
    gameId: GameIdSchema,
    createdAt: DateTimeSchema,
    startedAt: Type.Union([DateTimeSchema, Type.Null()]),
    finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
    revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    documentHash: Type.Union([HashSchema, Type.Null()]),
    projectionHash: Type.Union([HashSchema, Type.Null()]),
    error: Type.Union([Type.String(), Type.Null()]),
    errorCategory: Type.Union([ErrorCategorySchema, Type.Null()]),
  },
  strict,
);

export const ImportJobCreatedSchema = Type.Object(
  { jobId: IdSchema, status: JobStatusSchema },
  strict,
);

export const ImportReadyBatchCreateRequestSchema = Type.Object(
  { idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }) },
  strict,
);

export const ImportReadyBatchJobSchema = Type.Object(
  { jobId: IdSchema, gameId: GameIdSchema, status: JobStatusSchema },
  strict,
);

export const ImportReadyBatchCreatedSchema = Type.Object(
  {
    batchId: IdSchema,
    createdCount: Type.Integer({ minimum: 0 }),
    skippedCount: Type.Integer({ minimum: 0 }),
    jobs: Type.Array(ImportReadyBatchJobSchema),
  },
  strict,
);

export const ImportJobListSchema = Type.Object({ jobs: Type.Array(ImportJobSchema) }, strict);

export const DatabaseOverviewSchema = Type.Object(
  {
    database: DatabaseStatusSchema,
    counts: Type.Object(
      {
        readyToImport: Type.Integer({ minimum: 0 }),
        stored: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
  },
  strict,
);

export const RevisionCatalogItemSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 1 }),
    documentHash: HashSchema,
    projectionHash: HashSchema,
    sealed: Type.Boolean(),
    createdAt: DateTimeSchema,
    sealedAt: Type.Union([DateTimeSchema, Type.Null()]),
    original: Type.Boolean(),
    current: Type.Boolean(),
  },
  strict,
);

export const RevisionCatalogSchema = Type.Object(
  {
    gameId: GameIdSchema,
    currentRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    revisions: Type.Array(RevisionCatalogItemSchema),
  },
  strict,
);

export const ImportApiErrorSchema = ApiErrorSchema;

export type ImportJobCreateRequest = Static<typeof ImportJobCreateRequestSchema>;
export type ImportJob = Static<typeof ImportJobSchema>;
export type ImportJobCreated = Static<typeof ImportJobCreatedSchema>;
export type ImportReadyBatchCreateRequest = Static<typeof ImportReadyBatchCreateRequestSchema>;
export type ImportReadyBatchCreated = Static<typeof ImportReadyBatchCreatedSchema>;
export type ImportReadyBatchJob = Static<typeof ImportReadyBatchJobSchema>;
export type DatabaseOverview = Static<typeof DatabaseOverviewSchema>;
export type RevisionCatalog = Static<typeof RevisionCatalogSchema>;
export type RevisionCatalogItem = Static<typeof RevisionCatalogItemSchema>;
