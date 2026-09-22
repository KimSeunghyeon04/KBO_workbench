import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";
const strict = { additionalProperties: false } as const,
  text = Type.String(),
  count = Type.Integer({ minimum: 0 }),
  number = Type.Union([Type.Number(), Type.Null()]);
export const WorkloadAppearanceSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer({ minimum: 1 }),
    gameDate: text,
    teamId: text,
    teamName: text,
    side: Type.Union([Type.Literal("away"), Type.Literal("home")]),
    role: Type.Union([Type.Literal("starter"), Type.Literal("relief"), Type.Literal("unknown")]),
    pitches: count,
    battersFaced: count,
    outs: count,
  },
  strict,
);
export const WorkloadEncounterSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer(),
    paId: text,
    batterId: text,
    firstSequence: count,
    pitches: count,
  },
  strict,
);
export const WorkloadPitchBucketSchema = Type.Object(
  {
    gameId: text,
    revision: Type.Integer(),
    bucket: Type.Union([
      Type.Literal("1–25"),
      Type.Literal("26–50"),
      Type.Literal("51–75"),
      Type.Literal("76+"),
    ]),
    pitchType: Type.Union([text, Type.Null()]),
    stance: Type.Union([text, Type.Null()]),
    pitches: count,
    speedCount: count,
    meanSpeedKph: number,
    swings: count,
    whiffs: count,
  },
  strict,
);
const inherited = Type.Object(
  {
    entryPlayId: text,
    runnerId: text,
    currentRunnerId: text,
    responsiblePitcherId: text,
    outcome: Type.Union([
      Type.Literal("scored_during_spell"),
      Type.Literal("out"),
      Type.Literal("left_on_base"),
      Type.Literal("passed_to_next_pitcher"),
      Type.Literal("unknown"),
    ]),
    outcomePlayId: Type.Union([text, Type.Null()]),
  },
  strict,
);
export const PitcherWorkloadResponseSchema = Type.Object(
  {
    query: AnalysisScopeQuerySchema,
    scope: AnalysisScopeSchema,
    sourceHash: text,
    pitcherId: text,
    coverage: Type.Literal("collected_records_only"),
    lookbackCompetition: Type.Literal("all"),
    appearances: Type.Array(
      Type.Object(
        {
          ...WorkloadAppearanceSchema.properties,
          previousObservedDate: Type.Union([text, Type.Null()]),
          observedRestDays: number,
          previous3DaysPitches: count,
          previous7DaysPitches: count,
          observedConsecutiveDays: count,
          sameDayAppearances: count,
          sameDayEarlierPitches: Type.Null(),
          sameDayOrder: Type.Union([Type.Literal("single"), Type.Literal("unknown")]),
          encounters: Type.Array(
            Type.Object(
              {
                ...WorkloadEncounterSchema.properties,
                meetingNumber: Type.Integer({ minimum: 1 }),
              },
              strict,
            ),
          ),
          inherited: Type.Array(inherited),
          buckets: Type.Array(WorkloadPitchBucketSchema),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type WorkloadAppearance = Static<typeof WorkloadAppearanceSchema>;
export type WorkloadEncounter = Static<typeof WorkloadEncounterSchema>;
export type WorkloadPitchBucket = Static<typeof WorkloadPitchBucketSchema>;
export type PitcherWorkloadResponse = Static<typeof PitcherWorkloadResponseSchema>;
