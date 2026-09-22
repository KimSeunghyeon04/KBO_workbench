import { type Static, Type } from "@sinclair/typebox";

import { EventIdentitySchema } from "./identity.js";
import {
  HalfSchema,
  IdentifierSchema,
  ObservedStateSchema,
  PlayerIdSchema,
  RelayTextSchema,
  SideSchema,
  strict,
} from "./primitives.js";

const LedgerEventBase = {
  identity: EventIdentitySchema,
  sequence: Type.Integer({ minimum: 0 }),
  inning: Type.Integer({ minimum: 1, maximum: 99 }),
  half: HalfSchema,
  relayText: Type.Optional(RelayTextSchema),
  observedStateAfter: Type.Optional(ObservedStateSchema),
} as const;

export const HalfInningStartEventSchema = Type.Object(
  { ...LedgerEventBase, kind: Type.Literal("half_inning_start"), payload: Type.Object({}, strict) },
  strict,
);
export const BatterStartEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("batter_start"),
    payload: Type.Object({ batterId: PlayerIdSchema, pitcherId: PlayerIdSchema }, strict),
  },
  strict,
);

export const PitchCallSchema = Type.Union([
  Type.Literal("ball"),
  Type.Literal("called_strike"),
  Type.Literal("swinging_strike"),
  Type.Literal("foul"),
  Type.Literal("foul_bunt"),
  Type.Literal("foul_tip"),
  Type.Literal("in_play"),
  Type.Literal("hit_by_pitch"),
  Type.Literal("automatic_ball"),
  Type.Literal("automatic_strike"),
  Type.Literal("no_pitch"),
]);
export type PitchCall = Static<typeof PitchCallSchema>;
export const PitchMetadataSchema = Type.Object(
  {
    speedKph: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    pitchType: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" })),
  },
  strict,
);
export type PitchMetadata = Static<typeof PitchMetadataSchema>;
export const PitchEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("pitch"),
    payload: Type.Object(
      {
        sourcePitchId: Type.Optional(IdentifierSchema),
        ...PitchMetadataSchema.properties,
        call: PitchCallSchema,
        batterId: Type.Optional(PlayerIdSchema),
        pitcherId: Type.Optional(PlayerIdSchema),
      },
      strict,
    ),
  },
  strict,
);

export const PlateResultSchema = Type.Union([
  Type.Literal("single"),
  Type.Literal("double"),
  Type.Literal("triple"),
  Type.Literal("home_run"),
  Type.Literal("walk"),
  Type.Literal("intentional_walk"),
  Type.Literal("hit_by_pitch"),
  Type.Literal("strikeout"),
  Type.Literal("field_out"),
  Type.Literal("sacrifice_bunt"),
  Type.Literal("sacrifice_fly"),
  Type.Literal("fielder_choice"),
  Type.Literal("reached_on_error"),
  Type.Literal("interference"),
  Type.Literal("double_play"),
  Type.Literal("triple_play"),
  Type.Literal("other"),
]);
export type PlateResult = Static<typeof PlateResultSchema>;
export const BattedBallTypeSchema = Type.Union([
  Type.Literal("ground_ball"),
  Type.Literal("fly_ball"),
  Type.Literal("line_drive"),
  Type.Literal("popup"),
]);
export type BattedBallType = Static<typeof BattedBallTypeSchema>;
export const PlateResultEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("plate_result"),
    payload: Type.Object(
      {
        result: PlateResultSchema,
        batterId: PlayerIdSchema,
        pitcherId: PlayerIdSchema,
        creditedRbi: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
        outsRecorded: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        batterDestination: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
        battedBallType: Type.Optional(BattedBallTypeSchema),
        isBunt: Type.Optional(Type.Boolean()),
      },
      strict,
    ),
  },
  strict,
);

export const RunnerOutcomeSchema = Type.Union([
  Type.Literal("safe"),
  Type.Literal("out"),
  Type.Literal("scored"),
]);
export const RunnerOutKindSchema = Type.Union([
  Type.Literal("force"),
  Type.Literal("tag"),
  Type.Literal("batter_runner_before_first"),
  Type.Literal("strikeout"),
  Type.Literal("fly_catch"),
  Type.Literal("appeal_force"),
  Type.Literal("appeal_time"),
  Type.Literal("interference"),
  Type.Literal("abandonment"),
]);
export type RunnerOutKind = Static<typeof RunnerOutKindSchema>;
export const RunnerAdvanceReasonSchema = Type.Union([
  Type.Literal("stolen_base"),
  Type.Literal("caught_stealing"),
  Type.Literal("pickoff"),
  Type.Literal("wild_pitch"),
  Type.Literal("passed_ball"),
  Type.Literal("balk"),
  Type.Literal("defensive_indifference"),
  Type.Literal("error"),
  Type.Literal("appeal"),
  Type.Literal("other"),
]);
export type RunnerAdvanceReason = Static<typeof RunnerAdvanceReasonSchema>;
export const RunnerAdvanceContextSchema = Type.Union([
  Type.Object({ kind: Type.Literal("plate_result"), plateResultEventId: IdentifierSchema }, strict),
  Type.Object({ kind: Type.Literal("independent"), reason: RunnerAdvanceReasonSchema }, strict),
]);
export type RunnerAdvanceContext = Static<typeof RunnerAdvanceContextSchema>;
export const RunnerAdvanceEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("runner_advance"),
    payload: Type.Object(
      {
        runnerId: PlayerIdSchema,
        fromBase: Type.Integer({ minimum: 1, maximum: 3 }),
        toBase: Type.Integer({ minimum: 1, maximum: 4 }),
        outcome: RunnerOutcomeSchema,
        outKind: Type.Optional(RunnerOutKindSchema),
        supersedesThirdOut: Type.Optional(Type.Boolean()),
        responsiblePitcherId: Type.Optional(PlayerIdSchema),
        context: RunnerAdvanceContextSchema,
      },
      strict,
    ),
  },
  strict,
);

export const SubstitutionRoleSchema = Type.Union([
  Type.Literal("batter"),
  Type.Literal("runner"),
  Type.Literal("pitcher"),
  Type.Literal("fielder"),
]);
export const SubstitutionEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("substitution"),
    payload: Type.Object(
      {
        side: SideSchema,
        role: SubstitutionRoleSchema,
        incomingPlayerId: PlayerIdSchema,
        outgoingPlayerId: Type.Optional(PlayerIdSchema),
        battingOrder: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
        fieldPosition: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
      },
      strict,
    ),
  },
  strict,
);

export const ReviewEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("review"),
    payload: Type.Object(
      {
        decision: Type.Optional(
          Type.Union([
            Type.Literal("requested"),
            Type.Literal("upheld"),
            Type.Literal("overturned"),
            Type.Literal("inconclusive"),
          ]),
        ),
        reviewedEventId: Type.Optional(IdentifierSchema),
      },
      strict,
    ),
  },
  strict,
);
export const AdministrativeEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("administrative"),
    payload: Type.Object(
      {
        code: Type.Union([
          Type.Literal("announcement"),
          Type.Literal("mound_visit"),
          Type.Literal("break"),
          Type.Literal("footer"),
          Type.Literal("called_game"),
          Type.Literal("other"),
        ]),
      },
      strict,
    ),
  },
  strict,
);
export const UnresolvedEventSchema = Type.Object(
  {
    ...LedgerEventBase,
    kind: Type.Literal("unresolved"),
    payload: Type.Object(
      {
        sourceType: Type.String({ minLength: 1, maxLength: 100 }),
        suspectedKind: Type.Optional(
          Type.Union([
            Type.Literal("half_inning_start"),
            Type.Literal("batter_start"),
            Type.Literal("pitch"),
            Type.Literal("plate_result"),
            Type.Literal("runner_advance"),
            Type.Literal("substitution"),
            Type.Literal("review"),
            Type.Literal("administrative"),
          ]),
        ),
      },
      strict,
    ),
  },
  strict,
);

export const StagingRelayEventSchema = Type.Union([
  HalfInningStartEventSchema,
  BatterStartEventSchema,
  PitchEventSchema,
  PlateResultEventSchema,
  RunnerAdvanceEventSchema,
  SubstitutionEventSchema,
  ReviewEventSchema,
  AdministrativeEventSchema,
  UnresolvedEventSchema,
]);
export type StagingRelayEvent = Static<typeof StagingRelayEventSchema>;
export const StagingRelayEventKindSchema = Type.Union([
  Type.Literal("half_inning_start"),
  Type.Literal("batter_start"),
  Type.Literal("pitch"),
  Type.Literal("plate_result"),
  Type.Literal("runner_advance"),
  Type.Literal("substitution"),
  Type.Literal("review"),
  Type.Literal("administrative"),
  Type.Literal("unresolved"),
]);
export type StagingRelayEventKind = Static<typeof StagingRelayEventKindSchema>;
export type HalfInningStartEvent = Static<typeof HalfInningStartEventSchema>;
export type BatterStartEvent = Static<typeof BatterStartEventSchema>;
export type PitchEvent = Static<typeof PitchEventSchema>;
export type PlateResultEvent = Static<typeof PlateResultEventSchema>;
export type RunnerAdvanceEvent = Static<typeof RunnerAdvanceEventSchema>;
export type SubstitutionEvent = Static<typeof SubstitutionEventSchema>;
export type ReviewEvent = Static<typeof ReviewEventSchema>;
export type AdministrativeEvent = Static<typeof AdministrativeEventSchema>;
export type UnresolvedEvent = Static<typeof UnresolvedEventSchema>;
