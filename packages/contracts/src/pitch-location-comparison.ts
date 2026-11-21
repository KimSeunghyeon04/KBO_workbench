import { Type, type Static } from "@sinclair/typebox";
import { PitchLocationResponseSchema, PitchOutcomeQuerySchema } from "./pitch-outcomes.js";
import { PeriodMetricSchema } from "./analysis-period-comparison.js";

const strict = { additionalProperties: false } as const;
const nullableDifference = Type.Union([Type.Number({ minimum: -1, maximum: 1 }), Type.Null()]);
export const PitchLocationComparisonQuerySchema = Type.Object(
  {
    ...PitchOutcomeQuerySchema.properties,
    compareSeason: PitchOutcomeQuerySchema.properties.season,
    compareDateFrom: PitchOutcomeQuerySchema.properties.dateFrom,
    compareDateTo: PitchOutcomeQuerySchema.properties.dateTo,
  },
  strict,
);
const period = Type.Object(
  {
    ...Type.Pick(PitchLocationResponseSchema, ["query", "scope", "sourceHash", "coverage", "total"])
      .properties,
    cells: Type.Array(
      Type.Object(
        {
          ...PitchLocationResponseSchema.properties.cells.items.properties,
          usageRate: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
        },
        strict,
      ),
      { minItems: 25, maxItems: 25 },
    ),
  },
  strict,
);
export const PitchLocationComparisonResponseSchema = Type.Object(
  {
    query: PitchLocationComparisonQuerySchema,
    pitcherId: Type.String({ minLength: 1 }),
    first: period,
    second: period,
    metrics: Type.Array(PeriodMetricSchema),
    differences: Type.Array(
      Type.Object(
        {
          cell: Type.Integer({ minimum: 0, maximum: 24 }),
          usageRate: nullableDifference,
          whiffRate: nullableDifference,
          cswRate: nullableDifference,
          inPlayHitRate: nullableDifference,
        },
        strict,
      ),
      { minItems: 25, maxItems: 25 },
    ),
  },
  strict,
);
export type PitchLocationComparisonQuery = Static<typeof PitchLocationComparisonQuerySchema>;
export type PitchLocationComparisonResponse = Static<typeof PitchLocationComparisonResponseSchema>;

export function pitchLocationComparisonQueries(query: PitchLocationComparisonQuery) {
  const { compareSeason, compareDateFrom, compareDateTo, ...first } = query;
  const { season, dateFrom, dateTo, ...conditions } = first;
  void season;
  void dateFrom;
  void dateTo;
  return {
    first,
    second: {
      ...conditions,
      season: compareSeason,
      ...(compareDateFrom === undefined ? {} : { dateFrom: compareDateFrom }),
      ...(compareDateTo === undefined ? {} : { dateTo: compareDateTo }),
    },
  };
}
