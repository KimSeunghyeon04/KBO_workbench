import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { canonicalStringify } from "@kbo/contracts";

const strict = { additionalProperties: false } as const,
  hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const PITCH_QUALITY_MANIFEST_VERSION = 2;
export const PitchQualityManifestSchema = Type.Object(
  {
    version: Type.Literal(PITCH_QUALITY_MANIFEST_VERSION),
    through: Type.Integer(),
    seasons: Type.Array(
      Type.Object({ season: Type.Integer(), sourceHash: hash, heightHash: hash }, strict),
    ),
    games: Type.Array(
      Type.Object({ gameId: Type.String(), revision: Type.Integer(), documentHash: hash }, strict),
    ),
  },
  strict,
);
export type PitchQualityManifest = Static<typeof PitchQualityManifestSchema>;
// Keep archived models readable so model management can compare their provenance to the current input.
export const StoredPitchQualityManifestSchema = Type.Object(
  {
    ...PitchQualityManifestSchema.properties,
    version: Type.Union([Type.Literal(1), PitchQualityManifestSchema.properties.version]),
  },
  strict,
);
export type StoredPitchQualityManifest = Static<typeof StoredPitchQualityManifestSchema>;
export const pitchQualitySourceHash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
