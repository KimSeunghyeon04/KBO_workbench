import { type Static, Type } from "@sinclair/typebox";

import {
  ApiErrorSchema,
  ErrorCategorySchema,
  JobStatusSchema,
  GameCatalogItemSchema,
} from "./collection.js";
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
    expectedDocumentHash: Type.Optional(HashSchema),
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
    batchId: Type.Optional(IdSchema),
    interrupted: Type.Optional(Type.Boolean()),
    followUpPending: Type.Optional(Type.Boolean()),
  },
  strict,
);

export const ImportJobCreatedSchema = Type.Object(
  { jobId: IdSchema, status: JobStatusSchema },
  strict,
);

export const ImportReadyBatchCreateRequestSchema = Type.Object(
  {
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
    selectionId: Type.Optional(GameIdSchema),
  },
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

export const ImportSelectionRequestSchema = Type.Object(
  {
    selectionId: Type.Optional(GameIdSchema),
    season: Type.Optional(Type.Integer({ minimum: 1982, maximum: 9999 })),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    gameIds: Type.Optional(Type.Array(GameIdSchema, { maxItems: 50_000, uniqueItems: true })),
    excludedGameIds: Type.Optional(
      Type.Array(GameIdSchema, { maxItems: 50_000, uniqueItems: true }),
    ),
  },
  strict,
);
export const ImportSelectionSchema = Type.Object(
  {
    selectionId: GameIdSchema,
    createdAt: DateTimeSchema,
    count: Type.Integer({ minimum: 0 }),
    criteria: ImportSelectionRequestSchema,
  },
  strict,
);
export const ImportTargetSchema = Type.Object(
  {
    gameId: GameIdSchema,
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    documentHash: HashSchema,
    revision: Type.Integer({ minimum: 1 }),
  },
  strict,
);
export const ImportSelectionRecordSchema = Type.Object(
  {
    selection: ImportSelectionSchema,
    targets: Type.Array(ImportTargetSchema, { maxItems: 50_000 }),
  },
  strict,
);
export const ImportJobRecordSchema = Type.Object(
  {
    request: ImportJobCreateRequestSchema,
    job: ImportJobSchema,
    sourceSeason: Type.Union([Type.Integer({ minimum: 1982, maximum: 9999 }), Type.Null()]),
    target: Type.Union([ImportTargetSchema, Type.Null()]),
  },
  strict,
);
export const ImportBatchRecordSchema = Type.Object(
  {
    request: ImportReadyBatchCreateRequestSchema,
    batch: ImportReadyBatchCreatedSchema,
    records: Type.Array(ImportJobRecordSchema, { maxItems: 50_000 }),
  },
  strict,
);
export const ImportHistoryQuerySchema = Type.Object(
  {
    page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    batchId: Type.Optional(IdSchema),
    status: Type.Optional(JobStatusSchema),
  },
  strict,
);
export const ImportHistorySchema = Type.Object(
  {
    jobs: Type.Array(ImportJobSchema, { maxItems: 200 }),
    activeJobs: Type.Optional(Type.Array(ImportJobSchema, { maxItems: 200 })),
    total: Type.Integer({ minimum: 0 }),
    page: Type.Integer({ minimum: 1 }),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    summary: Type.Object(
      {
        total: Type.Integer({ minimum: 0 }),
        queued: Type.Integer({ minimum: 0 }),
        running: Type.Integer({ minimum: 0 }),
        succeeded: Type.Integer({ minimum: 0 }),
        failed: Type.Integer({ minimum: 0 }),
        cancelled: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
  },
  strict,
);
export const DatabaseGamesQuerySchema = Type.Object(
  {
    page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    season: Type.Optional(Type.Integer({ minimum: 1982, maximum: 9999 })),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    authority: Type.Union([Type.Literal("staging"), Type.Literal("database")]),
  },
  strict,
);
export const DatabaseGamesSchema = Type.Object(
  {
    games: Type.Array(GameCatalogItemSchema, { maxItems: 200 }),
    total: Type.Integer({ minimum: 0 }),
    page: Type.Integer({ minimum: 1 }),
    limit: Type.Integer({ minimum: 1, maximum: 200 }),
    seasons: Type.Array(Type.Integer({ minimum: 1982, maximum: 9999 })),
  },
  strict,
);
export type ImportSelectionRequest = Static<typeof ImportSelectionRequestSchema>;
export type ImportSelection = Static<typeof ImportSelectionSchema>;
export type ImportTarget = Static<typeof ImportTargetSchema>;
export type ImportSelectionRecord = Static<typeof ImportSelectionRecordSchema>;
export type ImportJobRecord = Static<typeof ImportJobRecordSchema>;
export type ImportBatchRecord = Static<typeof ImportBatchRecordSchema>;
export type ImportHistoryQuery = Static<typeof ImportHistoryQuerySchema>;
export type ImportHistory = Static<typeof ImportHistorySchema>;
export type DatabaseGamesQuery = Static<typeof DatabaseGamesQuerySchema>;
export type DatabaseGames = Static<typeof DatabaseGamesSchema>;
