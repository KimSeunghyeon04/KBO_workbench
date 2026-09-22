import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { BatterStrikeZoneSchema } from "./strike-zone.js";

import {
  ContractValidationError,
  PitchMetadataSchema,
  StagingRelayEventKindSchema,
  HalfSchema,
  RunnerOutKindSchema,
  SideSchema,
} from "./game-document.js";

const strict = { additionalProperties: false } as const;
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });
const GameIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 });
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const DateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });

export const ReplayPlayerSchema = Type.Object(
  {
    playerId: IdSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
  },
  strict,
);

export const ReplayBaseOccupantSchema = Type.Object(
  {
    runner: ReplayPlayerSchema,
    responsiblePitcher: ReplayPlayerSchema,
  },
  strict,
);

const NullablePlayerSchema = Type.Union([ReplayPlayerSchema, Type.Null()]);
const NullableBaseSchema = Type.Union([ReplayBaseOccupantSchema, Type.Null()]);

export const ReplayPlateAppearanceStateSchema = Type.Object(
  {
    startEventId: IdSchema,
    batter: ReplayPlayerSchema,
    pitcher: ReplayPlayerSchema,
    actualPitchCount: Type.Integer({ minimum: 0 }),
  },
  strict,
);

export const ReplayStateSchema = Type.Object(
  {
    inning: Type.Integer({ minimum: 0, maximum: 99 }),
    half: HalfSchema,
    halfActive: Type.Boolean(),
    balls: Type.Integer({ minimum: 0, maximum: 4 }),
    strikes: Type.Integer({ minimum: 0, maximum: 3 }),
    outs: Type.Integer({ minimum: 0, maximum: 3 }),
    bases: Type.Array(NullableBaseSchema, { minItems: 3, maxItems: 3 }),
    awayScore: Type.Integer({ minimum: 0 }),
    homeScore: Type.Integer({ minimum: 0 }),
    batter: NullablePlayerSchema,
    pitcher: NullablePlayerSchema,
    activePitchers: Type.Object({ away: NullablePlayerSchema, home: NullablePlayerSchema }, strict),
    plateAppearance: Type.Union([ReplayPlateAppearanceStateSchema, Type.Null()]),
  },
  strict,
);

export const ReplayFielderSchema = Type.Object(
  {
    side: SideSchema,
    player: ReplayPlayerSchema,
    battingOrder: Type.Union([Type.Integer({ minimum: 1, maximum: 9 }), Type.Null()]),
    positions: Type.Array(Type.String({ minLength: 1, maxLength: 30 }), { uniqueItems: true }),
  },
  strict,
);

export const ReplayRunnerMovementSchema = Type.Object(
  {
    movementId: IdSchema,
    sourceEventId: Type.Union([IdSchema, Type.Null()]),
    runner: ReplayPlayerSchema,
    fromBase: Type.Integer({ minimum: 0, maximum: 3 }),
    toBase: Type.Integer({ minimum: 1, maximum: 4 }),
    outcome: Type.Union([Type.Literal("safe"), Type.Literal("out"), Type.Literal("scored")]),
    outKind: Type.Union([RunnerOutKindSchema, Type.Null()]),
    supersedesThirdOut: Type.Union([Type.Boolean(), Type.Null()]),
    responsiblePitcher: ReplayPlayerSchema,
    derived: Type.Boolean(),
    sequence: Type.Integer({ minimum: 0 }),
  },
  strict,
);

export const ReplayTrackingCandidateSchema = Type.Object(
  {
    trackingId: IdSchema,
    sourcePitchId: Type.Union([IdSchema, Type.Null()]),
    pitchEventId: IdSchema,
    sourcePitchOrdinal: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
      description: "Naver tracking 원천의 ballcount 값이며 실제 PA 투구 순번과 독립적이다.",
    }),
    sequence: Type.Integer({ minimum: 0 }),
    pitcher: NullablePlayerSchema,
    batter: NullablePlayerSchema,
    observedAt: Type.Union([Type.String(), Type.Null()]),
    stance: Type.Union([Type.Literal("L"), Type.Literal("R"), Type.Literal("S"), Type.Null()]),
    x0: Type.Union([Type.Number(), Type.Null()]),
    y0: Type.Union([Type.Number(), Type.Null()]),
    z0: Type.Union([Type.Number(), Type.Null()]),
    vx0: Type.Union([Type.Number(), Type.Null()]),
    vy0: Type.Union([Type.Number(), Type.Null()]),
    vz0: Type.Union([Type.Number(), Type.Null()]),
    ax: Type.Union([Type.Number(), Type.Null()]),
    ay: Type.Union([Type.Number(), Type.Null()]),
    az: Type.Union([Type.Number(), Type.Null()]),
    crossPlateX: Type.Union([Type.Number(), Type.Null()]),
    crossPlateY: Type.Union([Type.Number(), Type.Null()]),
    strikeZone: Type.Union([BatterStrikeZoneSchema, Type.Null()]),
  },
  strict,
);

export const ReplayFrameSchema = Type.Object(
  {
    gameId: GameIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    playId: IdSchema,
    playNumber: Type.Integer({ minimum: 1 }),
    sequence: Type.Integer({ minimum: 0 }),
    kind: StagingRelayEventKindSchema,
    inning: Type.Integer({ minimum: 1, maximum: 99 }),
    half: HalfSchema,
    applied: Type.Boolean(),
    relayEvents: Type.Array(
      Type.Object(
        {
          eventId: IdSchema,
          sequence: Type.Integer({ minimum: 0 }),
          kind: StagingRelayEventKindSchema,
          relayText: Type.Union([Type.String({ minLength: 1, maxLength: 1_000 }), Type.Null()]),
          pitch: Type.Optional(PitchMetadataSchema),
        },
        strict,
      ),
      { minItems: 1 },
    ),
    before: ReplayStateSchema,
    after: ReplayStateSchema,
    movements: Type.Array(ReplayRunnerMovementSchema),
    fielders: Type.Array(ReplayFielderSchema),
    plateAppearance: Type.Union([ReplayPlateAppearanceStateSchema, Type.Null()]),
    tracking: Type.Array(ReplayTrackingCandidateSchema),
  },
  strict,
);

const TeamSummarySchema = Type.Object(
  { teamId: IdSchema, name: Type.String({ minLength: 1, maxLength: 100 }) },
  strict,
);

export const ReplayManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    gameId: GameIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    documentHash: HashSchema,
    projectionHash: HashSchema,
    frameHash: HashSchema,
    frameCount: Type.Integer({ minimum: 0 }),
    trackingCount: Type.Integer({ minimum: 0 }),
    gameDate: DateSchema,
    status: Type.Union([
      Type.Literal("scheduled"),
      Type.Literal("in_progress"),
      Type.Literal("final"),
      Type.Literal("suspended"),
      Type.Literal("cancelled"),
    ]),
    teams: Type.Object({ away: TeamSummarySchema, home: TeamSummarySchema }, strict),
    finalState: ReplayStateSchema,
    unlinkedTracking: Type.Array(ReplayTrackingCandidateSchema, { maxItems: 0 }),
    blockingCount: Type.Integer({ minimum: 0 }),
    warningCount: Type.Integer({ minimum: 0 }),
    defaultChunkSize: Type.Integer({ minimum: 1 }),
  },
  strict,
);

export const ReplayFramePageSchema = Type.Object(
  {
    gameId: GameIdSchema,
    revision: Type.Integer({ minimum: 1 }),
    documentHash: HashSchema,
    frameHash: HashSchema,
    startIndex: Type.Integer({ minimum: 0 }),
    frames: Type.Array(ReplayFrameSchema),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
  },
  strict,
);

export const ReplayFramesQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  strict,
);

export type ReplayPlayer = Static<typeof ReplayPlayerSchema>;
export type ReplayBaseOccupant = Static<typeof ReplayBaseOccupantSchema>;
export type ReplayPlateAppearanceState = Static<typeof ReplayPlateAppearanceStateSchema>;
export type ReplayState = Static<typeof ReplayStateSchema>;
export type ReplayFielder = Static<typeof ReplayFielderSchema>;
export type ReplayRunnerMovement = Static<typeof ReplayRunnerMovementSchema>;
export type ReplayTrackingCandidate = Static<typeof ReplayTrackingCandidateSchema>;
export type ReplayFrame = Static<typeof ReplayFrameSchema>;
export type ReplayManifest = Static<typeof ReplayManifestSchema>;
export type ReplayFramePage = Static<typeof ReplayFramePageSchema>;
export type ReplayFramesQuery = Static<typeof ReplayFramesQuerySchema>;

export function parseReplayManifest(value: unknown): ReplayManifest {
  return decodeReplayContract(ReplayManifestSchema, value);
}

export function parseReplayFrame(value: unknown): ReplayFrame {
  return decodeReplayContract(ReplayFrameSchema, value);
}

export function parseReplayFramePage(value: unknown): ReplayFramePage {
  return decodeReplayContract(ReplayFramePageSchema, value);
}

function decodeReplayContract<T>(schema: Parameters<typeof Value.Check>[0], value: unknown): T {
  if (!Value.Check(schema, value)) {
    throw new ContractValidationError(
      [...Value.Errors(schema, value)].map((error) => ({
        code: `schema_${String(error.type)}`,
        message: error.message,
        path: error.path || "$",
      })),
    );
  }
  return Value.Decode(schema, value) as T;
}
