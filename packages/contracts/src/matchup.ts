import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
import { PitchOutcomeRowSchema, TerminalPaRowSchema } from "./pitch-outcomes.js";
const strict = { additionalProperties: false } as const,
  text = Type.String({ minLength: 1 }),
  count = Type.Integer({ minimum: 0 }),
  ratio = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
export const MatchupQuerySchema = Type.Object(
  { ...AnalysisScopeQuerySchema.properties, pitcherId: text, batterId: text },
  strict,
);
export const MatchupConditionSchema = Type.Object(
  { pitchType: text, balls: count, strikes: count, stance: text, speedBand: Type.Integer() },
  strict,
);
export const MatchupConditionCountsSchema = Type.Object(
  {
    ...MatchupConditionSchema.properties,
    pitches: count,
    swings: count,
    whiffs: count,
    calledStrikes: count,
  },
  strict,
);
export const MatchupPitchSchema = Type.Pick(PitchOutcomeRowSchema, [
  "gameId",
  "revision",
  "pitchId",
  "gameDate",
  "pitcherId",
  "pitchType",
  "speedKph",
  "balls",
  "strikes",
  "stance",
  "swing",
  "whiff",
  "calledStrike",
]);
const cohort = Type.Object(
  {
    pitches: count,
    games: count,
    pitchers: count,
    swings: count,
    whiffs: count,
    calledStrikes: count,
    swingRate: ratio,
    whiffRate: ratio,
    calledStrikeRate: ratio,
    rows: Type.Array(MatchupPitchSchema, { maxItems: 10000 }),
  },
  strict,
);
export const MatchupResponseSchema = Type.Object(
  {
    query: MatchupQuerySchema,
    scope: AnalysisScopeSchema,
    sourceHash: text,
    predictionStatus: Type.Literal("not_validated"),
    speedBandKph: Type.Literal(5),
    minControls: Type.Literal(20),
    direct: cohort,
    directPlateAppearances: Type.Array(TerminalPaRowSchema),
    similar: cohort,
    excludedSimilar: count,
    matched: Type.Object(
      {
        pitches: count,
        swings: count,
        leagueSwingRate: ratio,
        leagueWhiffRate: ratio,
        leagueCalledStrikeRate: ratio,
        observedSwingRate: ratio,
        observedWhiffRate: ratio,
        observedCalledStrikeRate: ratio,
      },
      strict,
    ),
    conditions: Type.Array(
      Type.Object(
        {
          ...MatchupConditionSchema.properties,
          targetPitcherPitches: count,
          batterPitches: count,
          leaguePitches: count,
          leagueSwings: count,
          leagueSwingRate: ratio,
          leagueWhiffRate: ratio,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type MatchupQuery = Static<typeof MatchupQuerySchema>;
export type MatchupCondition = Static<typeof MatchupConditionSchema>;
export type MatchupConditionCounts = Static<typeof MatchupConditionCountsSchema>;
export type MatchupResponse = Static<typeof MatchupResponseSchema>;
