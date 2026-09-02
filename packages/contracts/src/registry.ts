import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { ContractValidationError } from "./game-document.js";

const strict = { additionalProperties: false } as const;
const DateSchema = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const DateTimeSchema = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
});
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const IdSchema = Type.String({ minLength: 1, maxLength: 200 });

export const RegistryPageKindSchema = Type.Union([Type.Literal("register"), Type.Literal("trade")]);

export const RegistrySourcePageSchema = Type.Object(
  {
    pageKind: RegistryPageKindSchema,
    requestKey: IdSchema,
    artifactKey: Type.String({ minLength: 1, maxLength: 500 }),
    contentHash: HashSchema,
    collectedAt: DateTimeSchema,
  },
  strict,
);

export const RegistryRegistrationPlayerSchema = Type.Object(
  {
    teamCode: IdSchema,
    teamName: Type.String({ minLength: 1, maxLength: 100 }),
    playerId: IdSchema,
    playerName: Type.String({ minLength: 1, maxLength: 100 }),
    rosterCategory: Type.String({ minLength: 1, maxLength: 100 }),
    uniformNumber: Type.Union([Type.String({ minLength: 1, maxLength: 20 }), Type.Null()]),
    positionText: Type.String({ minLength: 1, maxLength: 100 }),
    throwsBats: Type.Union([Type.String({ minLength: 1, maxLength: 30 }), Type.Null()]),
    birthDate: Type.Union([DateSchema, Type.Null()]),
    heightCm: Type.Union([Type.Integer({ minimum: 100, maximum: 250 }), Type.Null()]),
    weightKg: Type.Union([Type.Integer({ minimum: 30, maximum: 250 }), Type.Null()]),
  },
  strict,
);

export const RegistryRegistrationSnapshotSchema = Type.Object(
  {
    snapshotDate: DateSchema,
    teamCode: IdSchema,
    teamName: Type.String({ minLength: 1, maxLength: 100 }),
    sourceRequestKey: IdSchema,
    complete: Type.Boolean(),
    players: Type.Array(RegistryRegistrationPlayerSchema),
  },
  strict,
);

export const RegistryEventKindSchema = Type.Union([
  Type.Literal("name_change"),
  Type.Literal("military_hold"),
  Type.Literal("affiliation_add"),
  Type.Literal("number_change"),
  Type.Literal("waiver"),
  Type.Literal("voluntary_retirement"),
  Type.Literal("voluntary_return"),
  Type.Literal("free_agent_release"),
  Type.Literal("trade"),
  Type.Literal("free_agent_contract"),
  Type.Literal("free_agent_eligibility"),
  Type.Literal("draft"),
  Type.Literal("compensation"),
  Type.Literal("injured_list"),
  Type.Literal("leave"),
  Type.Literal("rehabilitation"),
  Type.Literal("suspension"),
  Type.Literal("unknown"),
]);

export const RegistryAffiliationEffectSchema = Type.Union([
  Type.Literal("start"),
  Type.Literal("end"),
  Type.Literal("transfer"),
  Type.Literal("none"),
  Type.Literal("unknown"),
]);

export const RegistryStatusEventSchema = Type.Object(
  {
    effectiveDate: DateSchema,
    rawCategory: Type.String({ minLength: 1, maxLength: 100 }),
    eventKind: RegistryEventKindSchema,
    affiliationEffect: RegistryAffiliationEffectSchema,
    teamName: Type.String({ minLength: 1, maxLength: 100 }),
    rawPlayerName: Type.String({ minLength: 1, maxLength: 100 }),
    rawPosition: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    rawNote: Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]),
    sourceRequestKey: IdSchema,
    sourceRowIndex: Type.Integer({ minimum: 0 }),
  },
  strict,
);

export const RegistrySeasonDatasetSchema = Type.Object(
  {
    season: Type.Integer({ minimum: 2017, maximum: 9999 }),
    dateFrom: DateSchema,
    dateTo: DateSchema,
    sourcePages: Type.Array(RegistrySourcePageSchema),
    registrationSnapshots: Type.Array(RegistryRegistrationSnapshotSchema),
    statusEvents: Type.Array(RegistryStatusEventSchema),
  },
  strict,
);

export type RegistryPageKind = Static<typeof RegistryPageKindSchema>;
export type RegistrySourcePage = Static<typeof RegistrySourcePageSchema>;
export type RegistryRegistrationPlayer = Static<typeof RegistryRegistrationPlayerSchema>;
export type RegistryRegistrationSnapshot = Static<typeof RegistryRegistrationSnapshotSchema>;
export type RegistryEventKind = Static<typeof RegistryEventKindSchema>;
export type RegistryAffiliationEffect = Static<typeof RegistryAffiliationEffectSchema>;
export type RegistryStatusEvent = Static<typeof RegistryStatusEventSchema>;
export type RegistrySeasonDataset = Static<typeof RegistrySeasonDatasetSchema>;

export function parseRegistrySeasonDataset(value: unknown): RegistrySeasonDataset {
  if (!Value.Check(RegistrySeasonDatasetSchema, value)) {
    throw new ContractValidationError(
      [...Value.Errors(RegistrySeasonDatasetSchema, value)].map((error) => ({
        code: `schema_${String(error.type)}`,
        message: error.message,
        path: error.path || "$",
      })),
    );
  }
  return Value.Decode(RegistrySeasonDatasetSchema, value);
}
