import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { CorrectionBatchSchema, CorrectionPreviewSchema } from "./correction.js";
import { ContractValidationError } from "./game-document.js";

const strict = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const DateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});
const NullableIdSchema = Type.Union([IdSchema, Type.Null()]);

export const RecordCorrectionDecisionSchema = Type.Union([
  Type.Literal("hit"),
  Type.Literal("error"),
  Type.Literal("fielder_choice"),
  Type.Literal("unknown"),
]);

export const RecordCorrectionParticipantRoleSchema = Type.Union([
  Type.Literal("batter"),
  Type.Literal("pitcher"),
  Type.Literal("fielder"),
  Type.Literal("unknown"),
]);

export const RecordCorrectionStatScopeSchema = Type.Union([
  Type.Literal("batter"),
  Type.Literal("pitcher"),
  Type.Literal("fielder"),
  Type.Literal("unknown"),
]);

export const RecordCorrectionStatCodeSchema = Type.Union([
  Type.Literal("plate_appearances"),
  Type.Literal("at_bats"),
  Type.Literal("runs"),
  Type.Literal("hits"),
  Type.Literal("doubles"),
  Type.Literal("triples"),
  Type.Literal("home_runs"),
  Type.Literal("runs_batted_in"),
  Type.Literal("walks"),
  Type.Literal("intentional_walks"),
  Type.Literal("hit_by_pitch"),
  Type.Literal("strikeouts"),
  Type.Literal("sacrifice_bunts"),
  Type.Literal("sacrifice_flies"),
  Type.Literal("batters_faced"),
  Type.Literal("outs_pitched"),
  Type.Literal("hits_allowed"),
  Type.Literal("runs_allowed"),
  Type.Literal("earned_runs"),
  Type.Literal("walks_allowed"),
  Type.Literal("intentional_walks_allowed"),
  Type.Literal("hit_batters"),
  Type.Literal("strikeouts_pitched"),
  Type.Literal("pitches"),
  Type.Literal("strikes"),
  Type.Literal("total_bases"),
  Type.Literal("fielding_errors"),
  Type.Literal("pitcher_at_bats"),
  Type.Literal("pitcher_sacrifice_bunts"),
  Type.Literal("unknown"),
]);

export const RecordCorrectionSupportKindSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("derived"),
  Type.Literal("evidence_only"),
  Type.Literal("unknown"),
]);

export const RecordCorrectionSourcePageSchema = Type.Object(
  {
    pageKind: Type.Union([
      Type.Literal("landing"),
      Type.Literal("control"),
      Type.Literal("records"),
    ]),
    requestKey: IdSchema,
    seriesId: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    pageNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    artifactKey: Type.String({ minLength: 1, maxLength: 500 }),
    contentHash: HashSchema,
    collectedAt: DateTimeSchema,
    rowCount: Type.Integer({ minimum: 0 }),
    totalCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  strict,
);

export const RecordCorrectionParticipantSchema = Type.Object(
  {
    participantIndex: Type.Integer({ minimum: 0 }),
    rawTeamName: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    rawPlayerName: Type.String({ minLength: 1, maxLength: 100 }),
    role: RecordCorrectionParticipantRoleSchema,
    parenthesized: Type.Boolean(),
  },
  strict,
);

export const RecordCorrectionStatChangeSchema = Type.Object(
  {
    statIndex: Type.Integer({ minimum: 0 }),
    participantIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    rawStatName: Type.String({ minLength: 1, maxLength: 100 }),
    statCode: RecordCorrectionStatCodeSchema,
    scope: RecordCorrectionStatScopeSchema,
    beforeValue: Type.Integer({ minimum: 0 }),
    afterValue: Type.Integer({ minimum: 0 }),
    supportKind: RecordCorrectionSupportKindSchema,
  },
  strict,
);

export const RecordCorrectionNoticeSchema = Type.Object(
  {
    noticeId: IdSchema,
    noticeHash: HashSchema,
    sourceRequestKey: IdSchema,
    sourceRowIndex: Type.Integer({ minimum: 0 }),
    seriesId: Type.Integer({ minimum: 0 }),
    seriesName: Type.String({ minLength: 1, maxLength: 100 }),
    recordNumber: Type.Integer({ minimum: 1 }),
    gameDate: DateSchema,
    weekdayText: Type.String({ maxLength: 20 }),
    awayTeamName: Type.String({ minLength: 1, maxLength: 100 }),
    homeTeamName: Type.String({ minLength: 1, maxLength: 100 }),
    doubleheaderNumber: Type.Union([Type.Integer({ minimum: 1, maximum: 2 }), Type.Null()]),
    venueName: Type.String({ minLength: 1, maxLength: 100 }),
    inning: Type.Integer({ minimum: 1, maximum: 99 }),
    half: Type.Union([Type.Literal("top"), Type.Literal("bottom")]),
    battingOrder: Type.Integer({ minimum: 1, maximum: 9 }),
    decisionBefore: RecordCorrectionDecisionSchema,
    decisionAfter: RecordCorrectionDecisionSchema,
    beforeRecordText: Type.String({ maxLength: 500 }),
    afterRecordText: Type.String({ maxLength: 500 }),
    contentText: Type.String({ maxLength: 2000 }),
    correctionDateText: Type.String({ minLength: 1, maxLength: 30 }),
    participants: Type.Array(RecordCorrectionParticipantSchema),
    statChanges: Type.Array(RecordCorrectionStatChangeSchema),
  },
  strict,
);

export const RecordCorrectionSeasonDatasetSchema = Type.Object(
  {
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    collectedAt: DateTimeSchema,
    sourcePages: Type.Array(RecordCorrectionSourcePageSchema, { minItems: 1 }),
    notices: Type.Array(RecordCorrectionNoticeSchema),
  },
  strict,
);

export const RecordCorrectionCaseStatusSchema = Type.Union([
  Type.Literal("action_required"),
  Type.Literal("already_applied"),
  Type.Literal("manual_review"),
  Type.Literal("out_of_scope"),
  Type.Literal("unmatched"),
  Type.Literal("resolved"),
  Type.Literal("dismissed"),
]);

export const RecordCorrectionQueueSchema = Type.Union([
  Type.Literal("needs_action"),
  Type.Literal("completed"),
  Type.Literal("all"),
]);

export const RecordCorrectionMatchCandidateSchema = Type.Object(
  {
    candidateId: IdSchema,
    gameId: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.Integer({ minimum: 1 }),
    documentHash: HashSchema,
    eventId: NullableIdSchema,
    batterPlayerId: NullableIdSchema,
    pitcherPlayerId: NullableIdSchema,
    label: Type.String({ minLength: 1, maxLength: 500 }),
    confidenceReason: Type.String({ minLength: 1, maxLength: 500 }),
  },
  strict,
);

export const RecordCorrectionCaseSchema = Type.Object(
  {
    noticeId: IdSchema,
    season: Type.Integer({ minimum: 1982 }),
    sourceRevision: Type.Integer({ minimum: 1 }),
    caseVersion: Type.Integer({ minimum: 1 }),
    status: RecordCorrectionCaseStatusSchema,
    gameId: NullableIdSchema,
    gameRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    eventId: NullableIdSchema,
    reasonCode: Type.String({ minLength: 1, maxLength: 100 }),
    reasonMessage: Type.String({ minLength: 1, maxLength: 1000 }),
    proposalHash: Type.Union([HashSchema, Type.Null()]),
    appliedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    assessedAt: DateTimeSchema,
    notice: RecordCorrectionNoticeSchema,
    candidates: Type.Array(RecordCorrectionMatchCandidateSchema),
  },
  strict,
);

export const RecordCorrectionSummarySchema = Type.Object(
  {
    counts: Type.Object(
      {
        actionRequired: Type.Integer({ minimum: 0 }),
        alreadyApplied: Type.Integer({ minimum: 0 }),
        manualReview: Type.Integer({ minimum: 0 }),
        outOfScope: Type.Integer({ minimum: 0 }),
        unmatched: Type.Integer({ minimum: 0 }),
        resolved: Type.Integer({ minimum: 0 }),
        dismissed: Type.Integer({ minimum: 0 }),
      },
      strict,
    ),
    alertCount: Type.Integer({ minimum: 0 }),
    lastSuccessfulAt: Type.Union([DateTimeSchema, Type.Null()]),
    nextScheduledAt: Type.Union([DateTimeSchema, Type.Null()]),
  },
  strict,
);

export const RecordCorrectionListQuerySchema = Type.Object(
  {
    season: Type.Optional(Type.Integer({ minimum: 1982, maximum: 9999 })),
    status: Type.Optional(RecordCorrectionCaseStatusSchema),
    queue: Type.Optional(RecordCorrectionQueueSchema),
    search: Type.Optional(Type.String({ maxLength: 100 })),
  },
  strict,
);

export const RecordCorrectionListItemSchema = Type.Object(
  {
    noticeId: IdSchema,
    caseVersion: Type.Integer({ minimum: 1 }),
    status: RecordCorrectionCaseStatusSchema,
    season: Type.Integer({ minimum: 1982 }),
    gameId: NullableIdSchema,
    assessedAt: DateTimeSchema,
    gameDate: DateSchema,
    awayTeamName: Type.String({ minLength: 1, maxLength: 200 }),
    homeTeamName: Type.String({ minLength: 1, maxLength: 200 }),
    venueName: Type.String({ minLength: 1, maxLength: 200 }),
    beforeRecordText: Type.String({ minLength: 1, maxLength: 1000 }),
    afterRecordText: Type.String({ minLength: 1, maxLength: 1000 }),
  },
  strict,
);

export const RecordCorrectionListSchema = Type.Object(
  { cases: Type.Array(RecordCorrectionListItemSchema) },
  strict,
);

export const RecordCorrectionReviewActionKindSchema = Type.Union([
  Type.Literal("select_candidate"),
  Type.Literal("dismiss"),
  Type.Literal("reopen"),
]);

export const RecordCorrectionReviewActionRequestSchema = Type.Object(
  {
    caseVersion: Type.Integer({ minimum: 1 }),
    action: RecordCorrectionReviewActionKindSchema,
    candidateId: Type.Union([IdSchema, Type.Null()]),
    reason: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
  },
  strict,
);

export const RecordCorrectionProposalChangeSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("event"),
      Type.Literal("official_batter"),
      Type.Literal("official_pitcher"),
      Type.Literal("derived"),
      Type.Literal("evidence_only"),
    ]),
    playerId: NullableIdSchema,
    field: Type.String({ minLength: 1, maxLength: 100 }),
    beforeValue: Type.Union([Type.String(), Type.Integer(), Type.Null()]),
    afterValue: Type.Union([Type.String(), Type.Integer(), Type.Null()]),
    state: Type.Union([
      Type.Literal("change"),
      Type.Literal("already_applied"),
      Type.Literal("verified"),
      Type.Literal("evidence_only"),
      Type.Literal("conflict"),
    ]),
  },
  strict,
);

export const RecordCorrectionProposalSchema = Type.Object(
  {
    noticeId: IdSchema,
    caseVersion: Type.Integer({ minimum: 1 }),
    sessionId: IdSchema,
    sessionVersion: Type.Integer({ minimum: 0 }),
    baseDocumentHash: HashSchema,
    noticeSourceHash: HashSchema,
    proposalHash: HashSchema,
    eligible: Type.Boolean(),
    reasons: Type.Array(Type.String({ minLength: 1, maxLength: 1000 })),
    changes: Type.Array(RecordCorrectionProposalChangeSchema),
    batch: Type.Union([CorrectionBatchSchema, Type.Null()]),
    preview: Type.Union([CorrectionPreviewSchema, Type.Null()]),
  },
  strict,
);

export const RecordCorrectionProposalApplyRequestSchema = Type.Object(
  {
    expectedSessionVersion: Type.Integer({ minimum: 0 }),
    proposalHash: HashSchema,
  },
  strict,
);

export const RecordCorrectionDraftCreateResponseSchema = Type.Object(
  {
    sessionId: IdSchema,
    sessionVersion: Type.Integer({ minimum: 0 }),
    noticeId: IdSchema,
  },
  strict,
);

export const RecordCorrectionJobStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("cancelling"),
  Type.Literal("cancelled"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("no_change"),
]);

export const RecordCorrectionJobCreateRequestSchema = Type.Object(
  {
    seasons: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1982, maximum: 9999 }), {
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
      }),
    ),
    idempotencyKey: Type.String({ minLength: 8, maxLength: 200 }),
  },
  strict,
);

export const RecordCorrectionJobSchema = Type.Object(
  {
    jobId: IdSchema,
    status: RecordCorrectionJobStatusSchema,
    trigger: Type.Union([Type.Literal("manual"), Type.Literal("scheduled")]),
    seasons: Type.Array(Type.Integer({ minimum: 1982 }), { uniqueItems: true }),
    createdAt: DateTimeSchema,
    startedAt: Type.Union([DateTimeSchema, Type.Null()]),
    finishedAt: Type.Union([DateTimeSchema, Type.Null()]),
    completedSeasons: Type.Integer({ minimum: 0 }),
    totalSeasons: Type.Integer({ minimum: 0 }),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);

export const RecordCorrectionJobListSchema = Type.Object(
  { jobs: Type.Array(RecordCorrectionJobSchema) },
  strict,
);

export const RecordCorrectionJobCreatedSchema = Type.Object(
  { jobId: IdSchema, status: RecordCorrectionJobStatusSchema },
  strict,
);

export type RecordCorrectionDecision = Static<typeof RecordCorrectionDecisionSchema>;
export type RecordCorrectionStatCode = Static<typeof RecordCorrectionStatCodeSchema>;
export type RecordCorrectionStatScope = Static<typeof RecordCorrectionStatScopeSchema>;
export type RecordCorrectionSupportKind = Static<typeof RecordCorrectionSupportKindSchema>;
export type RecordCorrectionSourcePage = Static<typeof RecordCorrectionSourcePageSchema>;
export type RecordCorrectionParticipant = Static<typeof RecordCorrectionParticipantSchema>;
export type RecordCorrectionStatChange = Static<typeof RecordCorrectionStatChangeSchema>;
export type RecordCorrectionNotice = Static<typeof RecordCorrectionNoticeSchema>;
export type RecordCorrectionSeasonDataset = Static<typeof RecordCorrectionSeasonDatasetSchema>;
export type RecordCorrectionCaseStatus = Static<typeof RecordCorrectionCaseStatusSchema>;
export type RecordCorrectionQueue = Static<typeof RecordCorrectionQueueSchema>;
export type RecordCorrectionMatchCandidate = Static<typeof RecordCorrectionMatchCandidateSchema>;
export type RecordCorrectionCase = Static<typeof RecordCorrectionCaseSchema>;
export type RecordCorrectionListItem = Static<typeof RecordCorrectionListItemSchema>;
export type RecordCorrectionSummary = Static<typeof RecordCorrectionSummarySchema>;
export type RecordCorrectionReviewActionRequest = Static<
  typeof RecordCorrectionReviewActionRequestSchema
>;
export type RecordCorrectionProposal = Static<typeof RecordCorrectionProposalSchema>;
export type RecordCorrectionProposalChange = Static<typeof RecordCorrectionProposalChangeSchema>;
export type RecordCorrectionProposalApplyRequest = Static<
  typeof RecordCorrectionProposalApplyRequestSchema
>;
export type RecordCorrectionJob = Static<typeof RecordCorrectionJobSchema>;
export type RecordCorrectionJobCreated = Static<typeof RecordCorrectionJobCreatedSchema>;
export type RecordCorrectionJobCreateRequest = Static<
  typeof RecordCorrectionJobCreateRequestSchema
>;

export function recordCorrectionSupportKind(
  scope: RecordCorrectionStatScope,
  statCode: RecordCorrectionStatCode,
): RecordCorrectionSupportKind {
  if (statCode === "unknown" || scope === "unknown") return "unknown";
  if (scope === "fielder") return statCode === "fielding_errors" ? "evidence_only" : "unknown";
  if (scope === "batter") {
    if (statCode === "total_bases") return "derived";
    return [
      "plate_appearances",
      "at_bats",
      "runs",
      "hits",
      "doubles",
      "triples",
      "home_runs",
      "runs_batted_in",
      "walks",
      "intentional_walks",
      "hit_by_pitch",
      "strikeouts",
      "sacrifice_bunts",
      "sacrifice_flies",
    ].includes(statCode)
      ? "direct"
      : "unknown";
  }
  if (
    statCode === "pitcher_at_bats" ||
    statCode === "pitcher_sacrifice_bunts" ||
    statCode === "sacrifice_flies"
  )
    return "evidence_only";
  return [
    "batters_faced",
    "outs_pitched",
    "hits_allowed",
    "runs_allowed",
    "earned_runs",
    "walks_allowed",
    "intentional_walks_allowed",
    "hit_batters",
    "strikeouts_pitched",
    "pitches",
    "strikes",
  ].includes(statCode)
    ? "direct"
    : "unknown";
}

export function parseRecordCorrectionSeasonDataset(value: unknown): RecordCorrectionSeasonDataset {
  if (!Value.Check(RecordCorrectionSeasonDatasetSchema, value)) {
    throw new ContractValidationError(
      [...Value.Errors(RecordCorrectionSeasonDatasetSchema, value)].map((error) => ({
        code: `schema_${String(error.type)}`,
        message: error.message,
        path: error.path || "$",
      })),
    );
  }
  return Value.Decode(RecordCorrectionSeasonDatasetSchema, value);
}
