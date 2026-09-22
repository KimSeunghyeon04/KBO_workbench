import { type Static, Type } from "@sinclair/typebox";
import {
  CollectionJobCreateRequestSchema,
  CollectionJobSchema,
  GameCatalogItemSchema,
} from "./collection.js";

const strict = { additionalProperties: false } as const;
const id = Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 });
const date = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const timestamp = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});
const count = Type.Integer({ minimum: 0 });
const nullableText = Type.Union([Type.String(), Type.Null()]);

export const CollectionDateRangeSchema = Type.Object({ startDate: date, endDate: date }, strict);
export const CollectionScheduleEntrySchema = Type.Object(
  {
    gameId: id,
    gameDate: date,
    scheduledAt: timestamp,
    label: Type.String({ minLength: 1 }),
  },
  strict,
);
export const CollectionDiscoveryCreateSchema = Type.Object(
  {
    ...CollectionDateRangeSchema.properties,
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  },
  strict,
);
export const CollectionDiscoverySchema = Type.Object(
  {
    discoveryId: id,
    range: CollectionDateRangeSchema,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    createdAt: timestamp,
    finishedAt: Type.Union([timestamp, Type.Null()]),
    pageCount: count,
    gameCount: count,
    complete: Type.Boolean(),
    error: nullableText,
  },
  strict,
);
export const CollectionDiscoveryRecordSchema = Type.Object(
  {
    discovery: CollectionDiscoverySchema,
    idempotencyKey: Type.String(),
  },
  strict,
);
export const CollectionScheduleEntriesSchema = Type.Array(CollectionScheduleEntrySchema, {
  maxItems: 50_000,
});
export const CollectionDiscoveryListSchema = Type.Object(
  { discoveries: Type.Array(CollectionDiscoverySchema) },
  strict,
);
export const CollectionGameStateSchema = Type.Union([
  Type.Literal("uncollected"),
  Type.Literal("staging"),
  Type.Literal("quarantine"),
  Type.Literal("source_failure"),
  Type.Literal("database"),
]);
export const CollectionGameSummarySchema = Type.Object(
  {
    gameId: id,
    gameDate: Type.Union([date, Type.Null()]),
    label: Type.String(),
    scheduledAt: Type.Union([timestamp, Type.Null()]),
    state: CollectionGameStateSchema,
    databaseRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    workspace: Type.Union([GameCatalogItemSchema, Type.Null()]),
    updatedAt: Type.Union([timestamp, Type.Null()]),
    blockingFindings: count,
    warningFindings: count,
  },
  strict,
);
export const CollectionCountsSchema = Type.Object(
  {
    total: count,
    uncollected: Type.Union([count, Type.Null()]),
    staging: count,
    quarantine: count,
    source_failure: count,
    database: count,
  },
  strict,
);
export const CollectionOverviewSchema = Type.Object(
  {
    discovery: CollectionDiscoverySchema,
    counts: CollectionCountsSchema,
    unknownDateCount: count,
    groups: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          startDate: date,
          endDate: date,
          counts: CollectionCountsSchema,
        },
        strict,
      ),
    ),
  },
  strict,
);
export const CollectionGamesQuerySchema = Type.Object(
  {
    startDate: Type.Optional(date),
    endDate: Type.Optional(date),
    search: Type.Optional(Type.String({ maxLength: 200 })),
    state: Type.Optional(CollectionGameStateSchema),
    unknownDate: Type.Optional(Type.Boolean()),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  strict,
);
export const CollectionOverviewQuerySchema = Type.Object(
  {
    startDate: Type.Optional(date),
    endDate: Type.Optional(date),
    groupBy: Type.Optional(Type.Union([Type.Literal("month"), Type.Literal("day")])),
  },
  strict,
);
export const CollectionGamePageSchema = Type.Object(
  {
    games: Type.Array(CollectionGameSummarySchema),
    total: count,
    page: count,
    limit: count,
  },
  strict,
);
export const CollectionSelectionCreateSchema = Type.Object(
  {
    discoveryId: id,
    range: CollectionDateRangeSchema,
    target: Type.Union([Type.Literal("uncollected"), Type.Literal("source_failure")]),
    mode: Type.Union([Type.Literal("all_matching"), Type.Literal("explicit")]),
    gameIds: Type.Array(id, { maxItems: 50_000, uniqueItems: true }),
    excludedGameIds: Type.Array(id, { maxItems: 50_000, uniqueItems: true }),
    unknownDate: Type.Optional(Type.Boolean()),
  },
  strict,
);
export const CollectionSelectionSchema = Type.Object(
  {
    selectionId: id,
    createdAt: timestamp,
    request: CollectionSelectionCreateSchema,
    count,
  },
  strict,
);
export const CollectionSelectionEntrySchema = Type.Object(
  {
    game: CollectionGameSummarySchema,
    workspaceToken: nullableText,
  },
  strict,
);
export const CollectionSelectionRecordSchema = Type.Object(
  {
    selection: CollectionSelectionSchema,
    entries: Type.Array(CollectionSelectionEntrySchema, { maxItems: 50_000 }),
  },
  strict,
);
export const CollectionItemOutcomeSchema = Type.Union([
  Type.Literal("ready"),
  Type.Literal("quarantined"),
  Type.Literal("source_failure"),
  Type.Literal("unchanged"),
  Type.Literal("skipped"),
  Type.Literal("interrupted"),
]);
export const CollectionItemResultSchema = Type.Object(
  {
    gameId: id,
    gameDate: Type.Union([date, Type.Null()]),
    label: Type.String(),
    outcome: CollectionItemOutcomeSchema,
    message: Type.String(),
    finishedAt: timestamp,
  },
  strict,
);
export const CollectionHistoryRecordSchema = Type.Object(
  {
    job: CollectionJobSchema,
    request: CollectionJobCreateRequestSchema,
    sequence: count,
    range: Type.Union([CollectionDateRangeSchema, Type.Null()]),
  },
  strict,
);
export const CollectionHistoryPageSchema = Type.Object(
  {
    records: Type.Array(CollectionHistoryRecordSchema),
    total: count,
    page: count,
    limit: count,
  },
  strict,
);
export const CollectionHistoryItemsSchema = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          result: CollectionItemResultSchema,
          current: Type.Union([CollectionGameSummarySchema, Type.Null()]),
        },
        strict,
      ),
    ),
    total: count,
    page: count,
    limit: count,
  },
  strict,
);
export const CollectionHistoryQuerySchema = Type.Object(
  {
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    problemsOnly: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type CollectionDateRange = Static<typeof CollectionDateRangeSchema>;
export type CollectionDiscovery = Static<typeof CollectionDiscoverySchema>;
export type CollectionDiscoveryCreate = Static<typeof CollectionDiscoveryCreateSchema>;
export type CollectionDiscoveryRecord = Static<typeof CollectionDiscoveryRecordSchema>;
export type CollectionScheduleEntry = Static<typeof CollectionScheduleEntrySchema>;
export type CollectionGameSummary = Static<typeof CollectionGameSummarySchema>;
export type CollectionGameState = Static<typeof CollectionGameStateSchema>;
export type CollectionCounts = Static<typeof CollectionCountsSchema>;
export type CollectionOverview = Static<typeof CollectionOverviewSchema>;
export type CollectionGamesQuery = Static<typeof CollectionGamesQuerySchema>;
export type CollectionOverviewQuery = Static<typeof CollectionOverviewQuerySchema>;
export type CollectionGamePage = Static<typeof CollectionGamePageSchema>;
export type CollectionSelectionCreate = Static<typeof CollectionSelectionCreateSchema>;
export type CollectionSelection = Static<typeof CollectionSelectionSchema>;
export type CollectionSelectionEntry = Static<typeof CollectionSelectionEntrySchema>;
export type CollectionSelectionRecord = Static<typeof CollectionSelectionRecordSchema>;
export type CollectionItemResult = Static<typeof CollectionItemResultSchema>;
export type CollectionHistoryRecord = Static<typeof CollectionHistoryRecordSchema>;
export type CollectionHistoryPage = Static<typeof CollectionHistoryPageSchema>;
export type CollectionHistoryItems = Static<typeof CollectionHistoryItemsSchema>;
