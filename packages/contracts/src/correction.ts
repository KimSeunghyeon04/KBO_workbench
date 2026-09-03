import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  StagingGameDocumentV2Schema,
  StagingRelayEventSchema,
  OfficialBatterRecordSchema,
  OfficialPitcherRecordSchema,
  PitchCallSchema,
  RosterPlayerSchema,
  SideSchema,
  TrackingExclusionReasonSchema,
} from "./game-document.js";

const strict = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const GameIdSchema = Type.String({
  pattern: "^[A-Za-z0-9_-]+$",
  minLength: 1,
  maxLength: 100,
});
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const EventIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});

const CommandBase = { commandId: IdSchema } as const;

export const AddEventCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("add_event"),
    event: StagingRelayEventSchema,
    beforeEventId: Type.Union([EventIdSchema, Type.Null()]),
  },
  strict,
);
export const DeleteEventCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("delete_event"),
    eventId: EventIdSchema,
  },
  strict,
);
export const ReplaceEventCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("replace_event"),
    eventId: EventIdSchema,
    event: StagingRelayEventSchema,
  },
  strict,
);
export const MoveEventCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("move_event"),
    eventId: EventIdSchema,
    beforeEventId: Type.Union([EventIdSchema, Type.Null()]),
  },
  strict,
);
export const UpdateRosterPlayerCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("update_roster_player"),
    side: SideSchema,
    playerId: IdSchema,
    player: RosterPlayerSchema,
  },
  strict,
);
export const UpdateRosterPositionCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("update_roster_position"),
    side: SideSchema,
    playerId: IdSchema,
    positions: Type.Array(Type.String({ minLength: 1, maxLength: 30 }), {
      uniqueItems: true,
    }),
  },
  strict,
);
export const UpdateOfficialRecordCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("update_official_record"),
    recordType: Type.Literal("batter"),
    playerId: IdSchema,
    record: OfficialBatterRecordSchema,
  },
  strict,
);
export const UpdateOfficialPitcherRecordCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("update_official_record"),
    recordType: Type.Literal("pitcher"),
    playerId: IdSchema,
    record: OfficialPitcherRecordSchema,
  },
  strict,
);
export const LinkTrackingCandidateCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("link_tracking_candidate"),
    trackingId: IdSchema,
    pitchEventId: EventIdSchema,
  },
  strict,
);
export const MarkTrackingDuplicateCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("mark_tracking_duplicate"),
    trackingId: IdSchema,
    canonicalTrackingId: IdSchema,
  },
  strict,
);
export const ExcludeTrackingCandidateCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("exclude_tracking_candidate"),
    trackingId: IdSchema,
    reason: TrackingExclusionReasonSchema,
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  strict,
);
export const UnlinkTrackingCandidateCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("unlink_tracking_candidate"),
    trackingId: IdSchema,
  },
  strict,
);
export const ReconcileTrackingPlateAppearanceContextsCommandSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("reconcile_tracking_plate_appearance_contexts"),
  },
  strict,
);
export const AtomicCorrectionCommandSchema = Type.Union([
  AddEventCommandSchema,
  DeleteEventCommandSchema,
  ReplaceEventCommandSchema,
  MoveEventCommandSchema,
  UpdateRosterPlayerCommandSchema,
  UpdateRosterPositionCommandSchema,
  UpdateOfficialRecordCommandSchema,
  UpdateOfficialPitcherRecordCommandSchema,
  LinkTrackingCandidateCommandSchema,
  MarkTrackingDuplicateCommandSchema,
  ExcludeTrackingCandidateCommandSchema,
  UnlinkTrackingCandidateCommandSchema,
  ReconcileTrackingPlateAppearanceContextsCommandSchema,
]);

export const CorrectionBatchSchema = Type.Object(
  {
    ...CommandBase,
    kind: Type.Literal("correction_batch"),
    commands: Type.Array(AtomicCorrectionCommandSchema, {
      minItems: 1,
      maxItems: 100,
    }),
  },
  strict,
);

export const CorrectionCommandSchema = Type.Union([
  AtomicCorrectionCommandSchema,
  CorrectionBatchSchema,
]);

export const FindingDetailSchema = Type.Object(
  {
    field: Type.String(),
    expected: Type.Optional(
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    ),
    actual: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
  },
  strict,
);
export const FindingSchema = Type.Object(
  {
    code: Type.String(),
    category: Type.Union([
      Type.Literal("source"),
      Type.Literal("domain"),
      Type.Literal("persistence"),
    ]),
    severity: Type.Union([Type.Literal("warning"), Type.Literal("blocking")]),
    message: Type.String(),
    gameId: GameIdSchema,
    eventId: Type.Optional(EventIdSchema),
    eventSequence: Type.Optional(Type.Integer({ minimum: 0 })),
    recordIdentity: Type.Optional(Type.String()),
    details: Type.Array(FindingDetailSchema),
  },
  strict,
);

const NullablePlayerIdSchema = Type.Union([IdSchema, Type.Null()]);
export const CorrectionEventStateSchema = Type.Object(
  {
    balls: Type.Integer({ minimum: 0, maximum: 4 }),
    strikes: Type.Integer({ minimum: 0, maximum: 3 }),
    outs: Type.Integer({ minimum: 0, maximum: 3 }),
    bases: Type.Array(NullablePlayerIdSchema, { minItems: 3, maxItems: 3 }),
    awayScore: Type.Integer({ minimum: 0 }),
    homeScore: Type.Integer({ minimum: 0 }),
    batterId: NullablePlayerIdSchema,
    pitcherId: NullablePlayerIdSchema,
  },
  strict,
);
export const CorrectionEventContextSchema = Type.Object(
  {
    eventId: EventIdSchema,
    applied: Type.Boolean(),
    before: CorrectionEventStateSchema,
    after: CorrectionEventStateSchema,
    pitch: Type.Optional(
      Type.Object(
        {
          plateAppearanceEventId: Type.Union([EventIdSchema, Type.Null()]),
          pitchEventNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
          actualPitchNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
          batterId: NullablePlayerIdSchema,
          pitcherId: NullablePlayerIdSchema,
          sourcePitchId: Type.Union([IdSchema, Type.Null()]),
          call: PitchCallSchema,
          actual: Type.Boolean(),
        },
        strict,
      ),
    ),
  },
  strict,
);

export const CorrectionCalculatedBatterRecordSchema = Type.Object(
  {
    playerId: IdSchema,
    side: SideSchema,
    plateAppearances: Type.Integer({ minimum: 0 }),
    atBats: Type.Integer({ minimum: 0 }),
    runs: Type.Integer({ minimum: 0 }),
    hits: Type.Integer({ minimum: 0 }),
    doubles: Type.Integer({ minimum: 0 }),
    triples: Type.Integer({ minimum: 0 }),
    homeRuns: Type.Integer({ minimum: 0 }),
    runsBattedIn: Type.Integer({ minimum: 0 }),
    walks: Type.Integer({ minimum: 0 }),
    intentionalWalks: Type.Integer({ minimum: 0 }),
    hitByPitch: Type.Integer({ minimum: 0 }),
    strikeouts: Type.Integer({ minimum: 0 }),
    sacrificeBunts: Type.Integer({ minimum: 0 }),
    sacrificeFlies: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export const CorrectionCalculatedPitcherRecordSchema = Type.Object(
  {
    playerId: IdSchema,
    side: SideSchema,
    battersFaced: Type.Integer({ minimum: 0 }),
    outsRecorded: Type.Integer({ minimum: 0 }),
    hits: Type.Integer({ minimum: 0 }),
    runs: Type.Integer({ minimum: 0 }),
    earnedRuns: Type.Null(),
    walks: Type.Integer({ minimum: 0 }),
    intentionalWalks: Type.Integer({ minimum: 0 }),
    hitByPitch: Type.Integer({ minimum: 0 }),
    strikeouts: Type.Integer({ minimum: 0 }),
    pitches: Type.Integer({ minimum: 0 }),
    strikes: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export const CorrectionCalculatedRecordsSchema = Type.Object(
  {
    batters: Type.Array(CorrectionCalculatedBatterRecordSchema),
    pitchers: Type.Array(CorrectionCalculatedPitcherRecordSchema),
  },
  strict,
);

export const CorrectionSessionCreateRequestSchema = Type.Union([
  Type.Object(
    {
      authority: Type.Union([Type.Literal("staging"), Type.Literal("quarantine")]),
      gameId: GameIdSchema,
    },
    strict,
  ),
  Type.Object(
    {
      authority: Type.Literal("superseded"),
      gameId: GameIdSchema,
      snapshotId: Type.String({
        pattern: "^[0-9]+-[0-9a-f]{64}\\.document\\.json$",
        maxLength: 200,
      }),
    },
    strict,
  ),
]);
export const CorrectionGameCatalogItemSchema = Type.Object(
  {
    gameId: GameIdSchema,
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    authority: Type.Union([Type.Literal("staging"), Type.Literal("quarantine")]),
    updatedAt: DateTimeSchema,
  },
  strict,
);
export const CorrectionGameCatalogSchema = Type.Object(
  { games: Type.Array(CorrectionGameCatalogItemSchema) },
  strict,
);
export const CorrectionSessionSchema = Type.Object(
  {
    sessionId: IdSchema,
    authority: Type.Union([
      Type.Literal("staging"),
      Type.Literal("quarantine"),
      Type.Literal("superseded"),
    ]),
    snapshotId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    gameId: GameIdSchema,
    baseDocumentHash: HashSchema,
    sessionVersion: Type.Integer({ minimum: 0 }),
    draftDocumentHash: HashSchema,
    draftDocument: StagingGameDocumentV2Schema,
    storedFindings: Type.Array(FindingSchema),
    findings: Type.Array(FindingSchema),
    eventContexts: Type.Array(CorrectionEventContextSchema),
    calculatedRecords: CorrectionCalculatedRecordsSchema,
    blockingCount: Type.Integer({ minimum: 0 }),
    warningCount: Type.Integer({ minimum: 0 }),
    canUndo: Type.Boolean(),
    canRedo: Type.Boolean(),
    dirty: Type.Boolean(),
  },
  strict,
);
export const CorrectionCommandRequestSchema = Type.Object(
  {
    expectedSessionVersion: Type.Integer({ minimum: 0 }),
    command: Type.Unknown(),
    apply: Type.Boolean(),
  },
  strict,
);
export const CorrectionVersionRequestSchema = Type.Object(
  { expectedSessionVersion: Type.Integer({ minimum: 0 }) },
  strict,
);
export const CorrectionCommitRequestSchema = Type.Object(
  {
    expectedSessionVersion: Type.Integer({ minimum: 0 }),
    allowBlockingStaging: Type.Boolean(),
  },
  strict,
);
export const CorrectionPreviewSchema = Type.Object(
  {
    beforeDocumentHash: HashSchema,
    afterDocumentHash: HashSchema,
    beforeBlockingCount: Type.Integer({ minimum: 0 }),
    afterBlockingCount: Type.Integer({ minimum: 0 }),
    beforeWarningCount: Type.Integer({ minimum: 0 }),
    afterWarningCount: Type.Integer({ minimum: 0 }),
    eventCountDelta: Type.Integer(),
    trackingResolutionChanges: Type.Integer({ minimum: 0 }),
    addedFindingCodes: Type.Array(Type.String()),
    removedFindingCodes: Type.Array(Type.String()),
  },
  strict,
);
export const CorrectionMutationResultSchema = Type.Object(
  { session: CorrectionSessionSchema, preview: CorrectionPreviewSchema },
  strict,
);
export const CorrectionCommitResultSchema = Type.Object(
  {
    session: CorrectionSessionSchema,
    committedAuthority: Type.Union([Type.Literal("staging"), Type.Literal("quarantine")]),
  },
  strict,
);
export const CorrectionSourceEvidenceRelayRowSchema = Type.Object(
  {
    rowIndex: Type.Integer({ minimum: 0 }),
    sourceSequence: Type.Union([Type.Integer(), Type.Null()]),
    selected: Type.Boolean(),
    canonicalJson: Type.String(),
  },
  strict,
);
export const CorrectionSourceEvidenceTrackingRowSchema = Type.Object(
  {
    rowIndex: Type.Integer({ minimum: 0 }),
    sourcePitchId: Type.Union([IdSchema, Type.Null()]),
    canonicalJson: Type.String(),
  },
  strict,
);
export const CorrectionSourceEvidenceSchema = Type.Object(
  {
    eventId: EventIdSchema,
    endpoint: Type.String({ minLength: 1, maxLength: 100 }),
    blockIndex: Type.Integer({ minimum: 0 }),
    eventIndex: Type.Integer({ minimum: 0 }),
    relayRows: Type.Array(CorrectionSourceEvidenceRelayRowSchema),
    trackingRows: Type.Array(CorrectionSourceEvidenceTrackingRowSchema),
  },
  strict,
);
export type AtomicCorrectionCommand = Static<typeof AtomicCorrectionCommandSchema>;
export type CorrectionBatch = Static<typeof CorrectionBatchSchema>;
export type CorrectionCommand = Static<typeof CorrectionCommandSchema>;
export type CorrectionFinding = Static<typeof FindingSchema>;
export type CorrectionEventState = Static<typeof CorrectionEventStateSchema>;
export type CorrectionEventContext = Static<typeof CorrectionEventContextSchema>;
export type CorrectionCalculatedBatterRecord = Static<
  typeof CorrectionCalculatedBatterRecordSchema
>;
export type CorrectionCalculatedPitcherRecord = Static<
  typeof CorrectionCalculatedPitcherRecordSchema
>;
export type CorrectionCalculatedRecords = Static<typeof CorrectionCalculatedRecordsSchema>;
export type CorrectionGameCatalogItem = Static<typeof CorrectionGameCatalogItemSchema>;
export type CorrectionGameCatalog = Static<typeof CorrectionGameCatalogSchema>;
export type CorrectionSessionCreateRequest = Static<typeof CorrectionSessionCreateRequestSchema>;
export type CorrectionSession = Static<typeof CorrectionSessionSchema>;
export type CorrectionCommandRequest = Static<typeof CorrectionCommandRequestSchema>;
export type CorrectionCommitRequest = Static<typeof CorrectionCommitRequestSchema>;
export type CorrectionPreview = Static<typeof CorrectionPreviewSchema>;
export type CorrectionMutationResult = Static<typeof CorrectionMutationResultSchema>;
export type CorrectionCommitResult = Static<typeof CorrectionCommitResultSchema>;
export type CorrectionSourceEvidence = Static<typeof CorrectionSourceEvidenceSchema>;

export function parseCorrectionCommand(value: unknown): CorrectionCommand {
  return Value.Decode(CorrectionCommandSchema, value);
}
