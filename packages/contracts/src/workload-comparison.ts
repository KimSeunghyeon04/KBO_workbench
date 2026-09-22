import { Type, type Static } from "@sinclair/typebox";
import { AnalysisScopeQuerySchema, AnalysisScopeSchema } from "./analysis-scope.js";

const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0 });
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
export const WorkloadComparisonCellSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
    observedRole: Type.Union([
      Type.Literal("first_pitcher"),
      Type.Literal("later_pitcher"),
      Type.Literal("unknown"),
    ]),
    pitchBucket: Type.Integer({ minimum: 0, maximum: 3 }),
    meeting: Type.Union([Type.Integer({ minimum: 1, maximum: 3 }), Type.Null()]),
    pitchType: Type.Union([Type.String(), Type.Null()]),
    stance: Type.Union([Type.String(), Type.Null()]),
    balls: Type.Integer({ minimum: 0, maximum: 3 }),
    strikes: Type.Integer({ minimum: 0, maximum: 2 }),
    pitches: count,
    speedCount: count,
    speedSum: Type.Number({ minimum: 0 }),
    swings: count,
    whiffs: count,
  },
  strict,
);
export const WorkloadComparisonDimensionSchema = Type.Union([
  Type.Literal("rest"),
  Type.Literal("previous3Days"),
  Type.Literal("previous7Days"),
  Type.Literal("pitchNumber"),
  Type.Literal("meeting"),
]);
const group = Type.Object(
  {
    samples: count,
    games: count,
    rawMean: nullableNumber,
    matchedSamples: count,
    matchedGames: count,
    adjustedMean: nullableNumber,
  },
  strict,
);
export const WorkloadComparisonResponseSchema = Type.Object(
  {
    query: AnalysisScopeQuerySchema,
    scope: AnalysisScopeSchema,
    pitcherId: Type.String(),
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    definitionVersion: Type.Literal(1),
    coverage: Type.Literal("collected_records_only"),
    lookbackCompetition: Type.Literal("all"),
    policy: Type.Object(
      {
        minCellSamples: Type.Literal(5),
        minGroupSamples: Type.Literal(50),
        minGroupGames: Type.Literal(5),
        bootstrapReplicates: Type.Literal(600),
        minValidReplicates: Type.Literal(480),
        weighting: Type.Literal("minimum_group_samples"),
        conditions: Type.Literal("pitcher_season_entry_role_pitch_type_stance_count"),
      },
      strict,
    ),
    actualPitches: count,
    roleEvidence: Type.Object(
      { registeredPitches: count, observedPitches: count, unknownPitches: count },
      strict,
    ),
    excludedConditionPitches: count,
    dimensions: Type.Array(
      Type.Object(
        {
          dimension: WorkloadComparisonDimensionSchema,
          excludedWorkloadPitches: count,
          groupedPitches: count,
          comparisons: Type.Array(
            Type.Object(
              {
                reference: Type.String(),
                comparison: Type.String(),
                metric: Type.Union([
                  Type.Literal("speed"),
                  Type.Literal("swing"),
                  Type.Literal("whiff"),
                ]),
                status: Type.Union([
                  Type.Literal("ready"),
                  Type.Literal("insufficient_support"),
                  Type.Literal("unstable_interval"),
                ]),
                baseline: group,
                target: group,
                commonStrata: count,
                overlapWeight: count,
                difference: nullableNumber,
                interval: Type.Union([
                  Type.Object({ low: Type.Number(), high: Type.Number() }, strict),
                  Type.Null(),
                ]),
                validReplicates: count,
              },
              strict,
            ),
          ),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type WorkloadComparisonCell = Static<typeof WorkloadComparisonCellSchema>;
export type WorkloadComparisonDimension = Static<typeof WorkloadComparisonDimensionSchema>;
export type WorkloadComparisonResponse = Static<typeof WorkloadComparisonResponseSchema>;
