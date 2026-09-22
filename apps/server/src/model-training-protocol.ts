import { Type, type Static } from "@sinclair/typebox";
import {
  RunExpectancyModelSchema,
  CountRunModelSchema,
  WinModelSchema,
  ParkEnvironmentModelSchema,
  PitchQualityModelSchema,
  MatchupModelSchema,
} from "@kbo/contracts";
import {
  RunTrainingManifestSchema,
  ParkTrainingManifestSchema,
  PitchQualityManifestSchema,
} from "@kbo/persistence";
const strict = { additionalProperties: false } as const;
export const ModelTrainingResultSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("re24"),
      model: RunExpectancyModelSchema,
      manifest: RunTrainingManifestSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("count"),
      model: CountRunModelSchema,
      manifest: RunTrainingManifestSchema,
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("win"), model: WinModelSchema, manifest: RunTrainingManifestSchema },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("park"),
      model: ParkEnvironmentModelSchema,
      manifest: ParkTrainingManifestSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("quality"),
      model: PitchQualityModelSchema,
      manifest: PitchQualityManifestSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("matchup"),
      model: MatchupModelSchema,
      manifest: PitchQualityManifestSchema,
    },
    strict,
  ),
]);
export type ModelTrainingResult = Static<typeof ModelTrainingResultSchema>;
