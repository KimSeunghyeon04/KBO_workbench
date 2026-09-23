import { Type } from "@sinclair/typebox";
import { MatchupModelSchema, type MatchupModel } from "@kbo/contracts";
import { readAnalysisModelFile, writeAnalysisModelFile } from "./analysis-model-files.js";
import { PitchQualityManifestSchema, type PitchQualityManifest } from "./pitch-quality-manifest.js";
import { validMatchupModel } from "./matchup-model-validation.js";
const envelope = Type.Object(
  { model: MatchupModelSchema, manifest: PitchQualityManifestSchema },
  { additionalProperties: false },
);
export class MatchupModelWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(model: MatchupModel, manifest: PitchQualityManifest, signal?: AbortSignal) {
    if (!validMatchupModel(model, manifest))
      throw new Error("Invalid matchup model provenance or validation");
    return writeAnalysisModelFile(
      this.root,
      "matchup",
      model.trainedThrough,
      envelope,
      { model, manifest },
      this.assertWriter,
      signal,
    );
  }
  public async read(through: number): Promise<{ model: MatchupModel; hash: string } | null> {
    const result = await readAnalysisModelFile(this.root, "matchup", through, envelope);
    if (result === null) return null;
    try {
      return result.payload.model.trainedThrough === through &&
        validMatchupModel(result.payload.model, result.payload.manifest)
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
}
