import { type Static, Type } from "@sinclair/typebox";

import {
  HalfSchema,
  IdentifierSchema,
  PlayerIdSchema,
  SideSchema,
  strict,
  ZonedDateTimeSchema,
} from "./primitives.js";

export const TeamSchema = Type.Object(
  { teamId: IdentifierSchema, name: Type.String({ minLength: 1, maxLength: 100 }) },
  strict,
);
export const RosterPlayerSchema = Type.Object(
  {
    playerId: PlayerIdSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    battingOrder: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
    starter: Type.Boolean(),
    positions: Type.Array(Type.String({ minLength: 1, maxLength: 30 }), { uniqueItems: true }),
  },
  strict,
);
export const TeamRosterSchema = Type.Object(
  { teamId: IdentifierSchema, players: Type.Array(RosterPlayerSchema) },
  strict,
);
const TrackingSourceSchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1, maxLength: 100 }),
    blockIndex: Type.Integer({ minimum: 0 }),
    rowIndex: Type.Integer({ minimum: 0 }),
  },
  strict,
);
const TrackingPendingResolutionSchema = Type.Object({ kind: Type.Literal("pending") }, strict);
const TrackingLinkedResolutionSchema = Type.Object(
  { kind: Type.Literal("linked"), pitchEventId: IdentifierSchema },
  strict,
);
const TrackingDuplicateResolutionSchema = Type.Object(
  { kind: Type.Literal("duplicate"), canonicalTrackingId: IdentifierSchema },
  strict,
);
export const TrackingExclusionReasonSchema = Type.Union([
  Type.Literal("not_a_pitch"),
  Type.Literal("provider_conflict"),
  Type.Literal("invalid_measurement"),
  Type.Literal("manual_other"),
]);
const TrackingExcludedResolutionSchema = Type.Object(
  {
    kind: Type.Literal("excluded"),
    reason: TrackingExclusionReasonSchema,
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  strict,
);
export const TrackingResolutionSchema = Type.Union([
  TrackingPendingResolutionSchema,
  TrackingLinkedResolutionSchema,
  TrackingDuplicateResolutionSchema,
  TrackingExcludedResolutionSchema,
]);
export const TrackingCandidateSchema = Type.Object(
  {
    trackingId: IdentifierSchema,
    source: TrackingSourceSchema,
    sourcePitchId: Type.Optional(IdentifierSchema),
    sourcePitchOrdinal: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description:
        "Naver ptsOptions.ballcount 원천값. tracking 관측 순번일 수 있으며 PA 실제 투구 순번이 아니다.",
    }),
    sequence: Type.Integer({ minimum: 0 }),
    inning: Type.Integer({ minimum: 1, maximum: 99 }),
    half: HalfSchema,
    plateAppearanceEventId: Type.Optional(IdentifierSchema),
    pitcherId: Type.Optional(PlayerIdSchema),
    batterId: Type.Optional(PlayerIdSchema),
    observedAt: Type.Optional(ZonedDateTimeSchema),
    stance: Type.Optional(Type.Union([Type.Literal("L"), Type.Literal("R"), Type.Literal("S")])),
    x0: Type.Optional(Type.Number()),
    y0: Type.Optional(Type.Number()),
    z0: Type.Optional(Type.Number()),
    vx0: Type.Optional(Type.Number()),
    vy0: Type.Optional(Type.Number()),
    vz0: Type.Optional(Type.Number()),
    ax: Type.Optional(Type.Number()),
    ay: Type.Optional(Type.Number()),
    az: Type.Optional(Type.Number()),
    crossPlateX: Type.Optional(Type.Number()),
    crossPlateY: Type.Optional(Type.Number()),
    topSz: Type.Optional(Type.Number()),
    bottomSz: Type.Optional(Type.Number()),
    resolution: TrackingResolutionSchema,
  },
  strict,
);
export type TrackingCandidate = Static<typeof TrackingCandidateSchema>;
export type TrackingResolution = Static<typeof TrackingResolutionSchema>;
export type TrackingExclusionReason = Static<typeof TrackingExclusionReasonSchema>;
export const OfficialBatterRecordSchema = Type.Object(
  {
    playerId: PlayerIdSchema,
    side: SideSchema,
    plateAppearances: Type.Optional(Type.Integer({ minimum: 0 })),
    atBats: Type.Integer({ minimum: 0 }),
    runs: Type.Integer({ minimum: 0 }),
    hits: Type.Integer({ minimum: 0 }),
    doubles: Type.Optional(Type.Integer({ minimum: 0 })),
    triples: Type.Optional(Type.Integer({ minimum: 0 })),
    homeRuns: Type.Integer({ minimum: 0 }),
    runsBattedIn: Type.Integer({ minimum: 0 }),
    walks: Type.Integer({ minimum: 0 }),
    intentionalWalks: Type.Optional(Type.Integer({ minimum: 0 })),
    hitByPitch: Type.Optional(Type.Integer({ minimum: 0 })),
    strikeouts: Type.Integer({ minimum: 0 }),
    sacrificeBunts: Type.Optional(Type.Integer({ minimum: 0 })),
    sacrificeFlies: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);
export const OfficialPitcherRecordSchema = Type.Object(
  {
    playerId: PlayerIdSchema,
    side: SideSchema,
    battersFaced: Type.Integer({ minimum: 0 }),
    outsRecorded: Type.Integer({ minimum: 0 }),
    hits: Type.Integer({ minimum: 0 }),
    runs: Type.Integer({ minimum: 0 }),
    earnedRuns: Type.Integer({ minimum: 0 }),
    walks: Type.Integer({ minimum: 0 }),
    intentionalWalks: Type.Optional(Type.Integer({ minimum: 0 })),
    hitByPitch: Type.Integer({ minimum: 0 }),
    strikeouts: Type.Integer({ minimum: 0 }),
    pitches: Type.Optional(Type.Integer({ minimum: 0 })),
    strikes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);

export type OfficialBatterRecord = Static<typeof OfficialBatterRecordSchema>;
export type OfficialPitcherRecord = Static<typeof OfficialPitcherRecordSchema>;
