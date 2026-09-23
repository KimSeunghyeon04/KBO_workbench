import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { canonicalStringify } from "@kbo/contracts";

const strict = { additionalProperties: false } as const,
  hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const PitchQualityManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
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
export const pitchQualitySourceHash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
