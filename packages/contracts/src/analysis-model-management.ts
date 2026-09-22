import { Type, type Static } from "@sinclair/typebox";
import { ZonedDateTimeSchema } from "./game-document/primitives.js";
const strict = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const nullableHash = Type.Union([hash, Type.Null()]);
export const AnalysisModelKindSchema = Type.Union([
  Type.Literal("re24"),
  Type.Literal("count"),
  Type.Literal("win"),
  Type.Literal("park"),
  Type.Literal("quality"),
  Type.Literal("matchup"),
]);
export type AnalysisModelKind = Static<typeof AnalysisModelKindSchema>;
export const AnalysisModelSeasonSchema = Type.Integer({ minimum: 2020, maximum: 2025 });
export const AnalysisModelTrainingSeasonSchema = Type.Integer({ minimum: 2020, maximum: 2024 });
export const AnalysisModelPeriodSchema = Type.Object(
  {
    trainedThrough: Type.Integer({ minimum: 2019, maximum: 2024 }),
    applicationSeason: AnalysisModelSeasonSchema,
    trainingStartSeason: Type.Integer({ minimum: 2020, maximum: 2022 }),
    validationSeasons: Type.Array(AnalysisModelTrainingSeasonSchema, {
      maxItems: 2,
      uniqueItems: true,
    }),
    support: Type.Union([
      Type.Literal("eligible"),
      Type.Literal("insufficient_history"),
      Type.Literal("unsupported_rules"),
    ]),
  },
  strict,
);
export type AnalysisModelPeriod = Static<typeof AnalysisModelPeriodSchema>;
export const AnalysisModelStatusSchema = Type.Object(
  {
    ...AnalysisModelPeriodSchema.properties,
    kind: AnalysisModelKindSchema,
    state: Type.Union([
      Type.Literal("missing"),
      Type.Literal("stale"),
      Type.Literal("current"),
      Type.Literal("unsupported"),
    ]),
    sourceHash: nullableHash,
    modelHash: nullableHash,
    adoptedTargets: Type.Integer({ minimum: 0 }),
    totalTargets: Type.Integer({ minimum: 1 }),
  },
  strict,
);
export type AnalysisModelStatus = Static<typeof AnalysisModelStatusSchema>;
export const AnalysisModelJobIdSchema = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
export const AnalysisModelRefreshSchema = Type.Object(
  {
    requestId: AnalysisModelJobIdSchema,
    force: Type.Boolean(),
    applicationSeason: AnalysisModelSeasonSchema,
  },
  strict,
);
export const LegacyAnalysisModelJobSchema = Type.Object(
  {
    id: AnalysisModelJobIdSchema,
    force: Type.Boolean(),
    trigger: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
    sequence: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    createdAt: ZonedDateTimeSchema,
    updatedAt: ZonedDateTimeSchema,
    error: Type.Union([Type.String(), Type.Null()]),
    steps: Type.Array(
      Type.Object(
        {
          kind: AnalysisModelKindSchema,
          state: Type.Union([
            Type.Literal("pending"),
            Type.Literal("running"),
            Type.Literal("skipped"),
            Type.Literal("published"),
            Type.Literal("failed"),
            Type.Literal("cancelled"),
          ]),
          phase: Type.Union([
            Type.Literal("waiting"),
            Type.Literal("reading"),
            Type.Literal("fitting"),
            Type.Literal("checking"),
            Type.Literal("publishing"),
            Type.Literal("done"),
          ]),
          modelHash: nullableHash,
        },
        strict,
      ),
      { minItems: 6, maxItems: 6 },
    ),
  },
  strict,
);
const legacyStep = LegacyAnalysisModelJobSchema.properties.steps.items;
export const AnalysisModelJobSchema = Type.Object(
  {
    ...LegacyAnalysisModelJobSchema.properties,
    version: Type.Literal(2),
    applicationSeason: AnalysisModelSeasonSchema,
    steps: Type.Array(
      Type.Object(
        {
          ...legacyStep.properties,
          state: Type.Union([...legacyStep.properties.state.anyOf, Type.Literal("unsupported")]),
        },
        strict,
      ),
      { minItems: 6, maxItems: 6 },
    ),
  },
  strict,
);
export type AnalysisModelJob = Static<typeof AnalysisModelJobSchema>;
export const LegacyAnalysisModelPolicySchema = Type.Object({ enabled: Type.Boolean() }, strict);
export const AnalysisModelPolicySchema = Type.Object(
  {
    version: Type.Literal(2),
    enabledSeasons: Type.Array(Type.Integer({ minimum: 2023, maximum: 2025 }), {
      maxItems: 3,
      uniqueItems: true,
    }),
  },
  strict,
);
export const AnalysisModelPolicyUpdateSchema = Type.Object(
  {
    applicationSeason: Type.Integer({ minimum: 2023, maximum: 2025 }),
    enabled: Type.Boolean(),
  },
  strict,
);
export const AnalysisModelManagementSchema = Type.Object(
  {
    models: Type.Array(AnalysisModelStatusSchema, { minItems: 6, maxItems: 6 }),
    latestJob: Type.Union([AnalysisModelJobSchema, Type.Null()]),
    policy: AnalysisModelPolicySchema,
    checkIntervalHours: Type.Literal(6),
  },
  strict,
);
