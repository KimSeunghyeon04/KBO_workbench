import { type Static, Type } from "@sinclair/typebox";
import { PitchReferenceSchema } from "./pitch-analysis.js";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 200 });
const count = Type.Integer({ minimum: 0 });
const numberOrNull = Type.Union([Type.Number(), Type.Null()]);
const textOrNull = Type.Union([Type.String(), Type.Null()]);
export const DisciplineQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    season: Type.Integer({ minimum: 1982, maximum: 2026 }),
    balls: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    strikes: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    pitchType: Type.Optional(id),
    stance: Type.Optional(Type.Union([Type.Literal("L"), Type.Literal("R"), Type.Literal("S")])),
    leaguePeriod: Type.Optional(Type.Union([Type.Literal("season"), Type.Literal("target")])),
  },
  strict,
);
export type DisciplineQuery = Static<typeof DisciplineQuerySchema>;
export const DisciplineParamsSchema = Type.Object({ batterId: id }, strict);
export const DisciplineCatalogSchema = Type.Object(
  {
    season: Type.Integer(),
    scope: AnalysisScopeSchema,
    batters: Type.Array(Type.Object({ batterId: id, name: id, pitches: count }, strict)),
  },
  strict,
);
export type DisciplineCatalog = Static<typeof DisciplineCatalogSchema>;

export const DisciplineRowSchema = Type.Object(
  {
    gameId: id,
    revision: Type.Integer({ minimum: 1 }),
    pitchId: id,
    gameDate: id,
    batterId: id,
    pitchType: textOrNull,
    stance: textOrNull,
    speedKph: numberOrNull,
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    eligible: Type.Boolean(),
    trackingId: textOrNull,
    supported: Type.Boolean(),
    inZone: Type.Union([Type.Boolean(), Type.Null()]),
    crossPlateX: numberOrNull,
    crossPlateY: numberOrNull,
    season: Type.Integer({ minimum: 1982, maximum: 2026 }),
    batterHeightCm: Type.Union([Type.Integer({ minimum: 100, maximum: 250 }), Type.Null()]),
    x0: numberOrNull,
    y0: numberOrNull,
    z0: numberOrNull,
    vx0: numberOrNull,
    vy0: numberOrNull,
    vz0: numberOrNull,
    ax: numberOrNull,
    ay: numberOrNull,
    az: numberOrNull,
  },
  strict,
);
export type DisciplineRow = Static<typeof DisciplineRowSchema>;
export const DisciplineSnapshotSchema = Type.Object(
  {
    season: Type.Integer(),
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    reference: PitchReferenceSchema.properties.reference,
    rows: Type.Union([Type.Array(DisciplineRowSchema), Type.Null()]),
  },
  strict,
);
export type DisciplineSnapshot = Static<typeof DisciplineSnapshotSchema>;

export const DisciplinePointSchema = Type.Object(
  {
    gameId: id,
    revision: Type.Integer({ minimum: 1 }),
    pitchId: id,
    gameDate: id,
    pitchType: textOrNull,
    stance: textOrNull,
    speedKph: numberOrNull,
    balls: count,
    strikes: count,
    swing: Type.Boolean(),
    whiff: Type.Boolean(),
    xCm: Type.Number(),
    zCm: Type.Number(),
    normalizedX: Type.Number(),
    normalizedZ: Type.Number(),
    inZone: Type.Boolean(),
    expectedXCm: numberOrNull,
    expectedZCm: numberOrNull,
    expectedInZone: Type.Union([Type.Boolean(), Type.Null()]),
    deltaXCm: numberOrNull,
    deltaZCm: numberOrNull,
    deltaMs: numberOrNull,
    cell: Type.Integer({ minimum: 0, maximum: 24 }),
  },
  strict,
);
export type DisciplinePoint = Static<typeof DisciplinePointSchema>;

export const DisciplineGroupSchema = Type.Object(
  {
    key: id,
    pitches: count,
    swings: count,
    whiffs: count,
    swingRate: numberOrNull,
    whiffRate: numberOrNull,
    matchedPitches: count,
    matchedSwings: count,
    matchedSwingRate: numberOrNull,
    leaguePitches: count,
    leagueSwingRate: numberOrNull,
    difference: numberOrNull,
  },
  strict,
);
export type DisciplineGroup = Static<typeof DisciplineGroupSchema>;
export const DisciplineCourseRatesSchema = Type.Object(
  {
    pitches: count,
    swings: count,
    zonePitches: count,
    zoneSwings: count,
    outsidePitches: count,
    outsideSwings: count,
    zoneRate: numberOrNull,
    swingRate: numberOrNull,
    chaseRate: numberOrNull,
    zoneSwingRate: numberOrNull,
  },
  strict,
);
export type DisciplineCourseRates = Static<typeof DisciplineCourseRatesSchema>;
const courseCohortSchema = Type.Object(
  { batter: DisciplineCourseRatesSchema, league: DisciplineCourseRatesSchema },
  strict,
);
export const DisciplineCourseComparisonSchema = Type.Object(
  {
    conventional: courseCohortSchema,
    common: courseCohortSchema,
    paired: Type.Array(
      Type.Object(
        {
          key: Type.Union([
            Type.Literal("outside"),
            Type.Literal("in-out"),
            Type.Literal("out-out"),
          ]),
          pitches: count,
          swings: count,
          matchedPitches: count,
          matchedSwings: count,
          matchedSwingRate: numberOrNull,
          courseLeagueSwingRate: numberOrNull,
          expectationLeagueSwingRate: numberOrNull,
          courseDifference: numberOrNull,
          expectationDifference: numberOrNull,
        },
        strict,
      ),
      { minItems: 3, maxItems: 3 },
    ),
  },
  strict,
);
export type DisciplineCourseComparison = Static<typeof DisciplineCourseComparisonSchema>;
export const DisciplineResponseSchema = Type.Object(
  {
    modelVersion: Type.Literal(1),
    query: DisciplineQuerySchema,
    batterId: id,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    baseline: Type.Union([
      Type.Null(),
      Type.Object(
        {
          sampleCount: count,
          arrivalMs: Type.Number(),
          firstGameDate: id,
          lastGameDate: id,
        },
        strict,
      ),
    ]),
    pitchTypes: Type.Array(Type.String()),
    coverage: Type.Object(
      {
        actualPitches: count,
        excludedSituations: count,
        missingLocation: count,
        locationPitches: count,
        comparisonPitches: count,
        leagueLocationPitches: count,
      },
      strict,
    ),
    summary: Type.Array(DisciplineGroupSchema),
    courseComparison: DisciplineCourseComparisonSchema,
    cells: Type.Array(DisciplineGroupSchema),
    transitions: Type.Array(DisciplineGroupSchema),
    deviations: Type.Object(
      {
        x: Type.Array(DisciplineGroupSchema),
        z: Type.Array(DisciplineGroupSchema),
        timing: Type.Array(DisciplineGroupSchema),
      },
      strict,
    ),
    points: Type.Array(DisciplinePointSchema),
  },
  strict,
);
export type DisciplineResponse = Static<typeof DisciplineResponseSchema>;
