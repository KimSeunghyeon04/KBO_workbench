import { Type, type Static } from "@sinclair/typebox";
import {
  AnalysisScopeQuerySchema,
  AnalysisScopeSchema,
  resolveAnalysisScope,
} from "./analysis-scope.js";
import { PitchOutcomeQuerySchema } from "./pitch-outcomes.js";
import { DisciplineQuerySchema } from "./batter-discipline.js";

const strict = { additionalProperties: false } as const;
const nullable = Type.Union([Type.Number(), Type.Null()]);
export const AnalysisPeriodQuerySchema = Type.Object(
  {
    ...AnalysisScopeQuerySchema.properties,
    compareSeason: AnalysisScopeQuerySchema.properties.season,
    compareDateFrom: AnalysisScopeQuerySchema.properties.dateFrom,
    compareDateTo: AnalysisScopeQuerySchema.properties.dateTo,
  },
  strict,
);
export const StatisticsPeriodQuerySchema = Type.Object(
  {
    ...AnalysisPeriodQuerySchema.properties,
    role: Type.Union([Type.Literal("pitcher"), Type.Literal("batter")]),
  },
  strict,
);
export const PitchProfilePeriodQuerySchema = AnalysisPeriodQuerySchema;
export const BatterPeriodQuerySchema = Type.Object(
  {
    ...PitchOutcomeQuerySchema.properties,
    ...AnalysisPeriodQuerySchema.properties,
  },
  strict,
);
export const DisciplinePeriodQuerySchema = Type.Object(
  {
    ...DisciplineQuerySchema.properties,
    ...AnalysisPeriodQuerySchema.properties,
  },
  strict,
);
const observation = Type.Object(
  {
    value: nullable,
    numerator: nullable,
    denominator: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  strict,
);
export const PeriodMetricSchema = Type.Object(
  {
    key: Type.String(),
    group: Type.String(),
    label: Type.String(),
    unit: Type.Union(
      (["rate", "number", "km/h", "cm", "ms", "outs"] as const).map((v) => Type.Literal(v)),
    ),
    first: observation,
    second: observation,
    difference: nullable,
  },
  strict,
);
export const PeriodSnapshotSchema = Type.Object(
  {
    scope: AnalysisScopeSchema,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    samples: Type.Array(
      Type.Object({ label: Type.String(), count: Type.Integer({ minimum: 0 }) }, strict),
    ),
  },
  strict,
);
const result = {
  playerId: Type.String({ minLength: 1 }),
  first: PeriodSnapshotSchema,
  second: PeriodSnapshotSchema,
  metrics: Type.Array(PeriodMetricSchema),
  warnings: Type.Array(Type.String()),
};
export const StatisticsPeriodResponseSchema = Type.Object(
  { ...result, query: StatisticsPeriodQuerySchema },
  strict,
);
export const PitchProfilePeriodResponseSchema = Type.Object(
  { ...result, query: PitchProfilePeriodQuerySchema },
  strict,
);
export const BatterPeriodResponseSchema = Type.Object(
  { ...result, query: BatterPeriodQuerySchema },
  strict,
);
export const DisciplinePeriodResponseSchema = Type.Object(
  { ...result, query: DisciplinePeriodQuerySchema },
  strict,
);
export type AnalysisPeriodQuery = Static<typeof AnalysisPeriodQuerySchema>;
export type StatisticsPeriodQuery = Static<typeof StatisticsPeriodQuerySchema>;
export type BatterPeriodQuery = Static<typeof BatterPeriodQuerySchema>;
export type DisciplinePeriodQuery = Static<typeof DisciplinePeriodQuerySchema>;
export type PeriodMetric = Static<typeof PeriodMetricSchema>;
export type PeriodSnapshot = Static<typeof PeriodSnapshotSchema>;
export type StatisticsPeriodResponse = Static<typeof StatisticsPeriodResponseSchema>;
export type PitchProfilePeriodResponse = Static<typeof PitchProfilePeriodResponseSchema>;
export type BatterPeriodResponse = Static<typeof BatterPeriodResponseSchema>;
export type DisciplinePeriodResponse = Static<typeof DisciplinePeriodResponseSchema>;

export function analysisPeriodQueries<T extends AnalysisPeriodQuery>(query: T) {
  const { compareSeason, compareDateFrom, compareDateTo, ...first } = query;
  const { dateFrom, dateTo, ...shared } = first;
  void dateFrom;
  void dateTo;
  const second = {
    ...shared,
    season: compareSeason,
    ...(compareDateFrom === undefined ? {} : { dateFrom: compareDateFrom }),
    ...(compareDateTo === undefined ? {} : { dateTo: compareDateTo }),
  };
  // Validate both boundaries before any repository reads; blank dates mean the whole season.
  for (const { season, competition, dateFrom, dateTo } of [first, second]) {
    resolveAnalysisScope({
      season,
      ...(competition === undefined ? {} : { competition }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    });
  }
  return { first, second };
}
