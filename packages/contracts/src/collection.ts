import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const strict = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const GameIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 });
const IsoDateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});

export const CollectionScopeSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("date_range"), startDate: IsoDateSchema, endDate: IsoDateSchema },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("game_ids"),
      gameIds: Type.Array(GameIdSchema, { minItems: 1, maxItems: 500, uniqueItems: true }),
    },
    strict,
  ),
]);

export const CollectionJobCreateRequestSchema = Type.Object(
  {
    scope: CollectionScopeSchema,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  },
  strict,
);

export const JobStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("cancelled"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
]);

export const ErrorCategorySchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("domain"),
  Type.Literal("persistence"),
  Type.Literal("internal"),
]);

export const CollectionJobSummarySchema = Type.Object(
  {
    ready: Type.Integer({ minimum: 0 }),
    quarantined: Type.Integer({ minimum: 0 }),
    sourceFailures: Type.Integer({ minimum: 0 }),
  },
  strict,
);

export const CollectionJobSchema = Type.Object(
  {
    jobId: IdSchema,
    kind: Type.Literal("collection"),
    status: JobStatusSchema,
    createdAt: DateTimeSchema,
    startedAt: Type.Union([DateTimeSchema, Type.Null()]),
    finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
    completedItems: Type.Integer({ minimum: 0 }),
    totalItems: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    currentGameId: Type.Union([GameIdSchema, Type.Null()]),
    summary: CollectionJobSummarySchema,
    error: Type.Union([Type.String(), Type.Null()]),
    errorCategory: Type.Union([ErrorCategorySchema, Type.Null()]),
  },
  strict,
);

export const CollectionJobListSchema = Type.Object(
  { jobs: Type.Array(CollectionJobSchema) },
  strict,
);

export const CollectionJobCreatedSchema = Type.Object(
  { jobId: IdSchema, status: JobStatusSchema },
  strict,
);

export const JobEventPayloadSchema = Type.Object(
  {
    message: Type.String(),
    gameId: Type.Union([GameIdSchema, Type.Null()]),
    disposition: Type.Union([
      Type.Literal("none"),
      Type.Literal("ready"),
      Type.Literal("quarantined"),
      Type.Literal("source_failure"),
    ]),
    completedItems: Type.Integer({ minimum: 0 }),
    totalItems: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  strict,
);

export const JobEventSchema = Type.Object(
  {
    eventId: IdSchema,
    jobId: IdSchema,
    sequence: Type.Integer({ minimum: 1 }),
    occurredAt: DateTimeSchema,
    type: Type.Union([
      Type.Literal("queued"),
      Type.Literal("started"),
      Type.Literal("progress"),
      Type.Literal("game_completed"),
      Type.Literal("cancelling"),
      Type.Literal("cancelled"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
    ]),
    payload: JobEventPayloadSchema,
  },
  strict,
);

export const CatalogAuthoritySchema = Type.Union([
  Type.Literal("staging"),
  Type.Literal("quarantine"),
  Type.Literal("source_failure"),
  Type.Literal("database"),
]);

const CatalogItemFields = {
  gameId: GameIdSchema,
  season: Type.Union([Type.Integer({ minimum: 1982, maximum: 9999 }), Type.Null()]),
  updatedAt: DateTimeSchema,
  blockingFindings: Type.Integer({ minimum: 0 }),
  warningFindings: Type.Integer({ minimum: 0 }),
} as const;

export const WorkspaceGameCatalogItemSchema = Type.Object(
  {
    ...CatalogItemFields,
    authority: Type.Union([
      Type.Literal("staging"),
      Type.Literal("quarantine"),
      Type.Literal("source_failure"),
    ]),
    supersededCount: Type.Integer({ minimum: 0 }),
  },
  strict,
);

export const CatalogTeamSchema = Type.Object(
  {
    teamId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
  },
  strict,
);

export const DatabaseGameCatalogItemSchema = Type.Object(
  {
    ...CatalogItemFields,
    authority: Type.Literal("database"),
    gameDate: IsoDateSchema,
    teams: Type.Object({ away: CatalogTeamSchema, home: CatalogTeamSchema }, strict),
    currentRevision: Type.Integer({ minimum: 1 }),
    revisionCount: Type.Integer({ minimum: 1 }),
  },
  strict,
);

export const GameCatalogItemSchema = Type.Union([
  WorkspaceGameCatalogItemSchema,
  DatabaseGameCatalogItemSchema,
]);

export const GameCatalogSchema = Type.Object({ games: Type.Array(GameCatalogItemSchema) }, strict);

export const ApiErrorSchema = Type.Object(
  {
    requestId: Type.String(),
    code: Type.String(),
    category: ErrorCategorySchema,
    message: Type.String(),
    retryable: Type.Boolean(),
    details: Type.Array(Type.Object({ field: Type.String(), message: Type.String() }, strict)),
  },
  strict,
);

export type CollectionScope = Static<typeof CollectionScopeSchema>;
export type CollectionJobCreateRequest = Static<typeof CollectionJobCreateRequestSchema>;
export type JobStatus = Static<typeof JobStatusSchema>;
export type ErrorCategory = Static<typeof ErrorCategorySchema>;
export type CollectionJob = Static<typeof CollectionJobSchema>;
export type CollectionJobCreated = Static<typeof CollectionJobCreatedSchema>;
export type JobEvent = Static<typeof JobEventSchema>;
export type CatalogAuthority = Static<typeof CatalogAuthoritySchema>;
export type GameCatalogItem = Static<typeof GameCatalogItemSchema>;
export type WorkspaceGameCatalogItem = Static<typeof WorkspaceGameCatalogItemSchema>;
export type DatabaseGameCatalogItem = Static<typeof DatabaseGameCatalogItemSchema>;
export type GameCatalog = Static<typeof GameCatalogSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;

export function parseCollectionJob(value: unknown): CollectionJob {
  return Value.Decode(CollectionJobSchema, value);
}
