import { Type } from "@sinclair/typebox";
import { PitchQualityModelSchema, type PitchQualityModel } from "@kbo/contracts";
import { readAnalysisModelFile, writeAnalysisModelFile } from "./analysis-model-files.js";
import { PitchQualityManifestSchema, type PitchQualityManifest } from "./pitch-quality-manifest.js";
import { validPitchQualityModel } from "./pitch-quality-model-validation.js";
const envelope = Type.Object(
  { model: PitchQualityModelSchema, manifest: PitchQualityManifestSchema },
  { additionalProperties: false },
);
export class PitchQualityWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(
    model: PitchQualityModel,
    manifest: PitchQualityManifest,
    signal?: AbortSignal,
  ) {
    if (!validPitchQualityModel(model, manifest))
      throw new Error("Invalid pitch quality provenance or feature dimensions");
    return writeAnalysisModelFile(
      this.root,
      "pitch-quality",
      model.trainedThrough,
      envelope,
      { model, manifest },
      this.assertWriter,
      signal,
    );
  }
  public async read(through: number): Promise<{ model: PitchQualityModel; hash: string } | null> {
    const result = await readAnalysisModelFile(this.root, "pitch-quality", through, envelope);
    if (result === null) return null;
    try {
      return validPitchQualityModel(result.payload.model, result.payload.manifest) &&
        result.payload.model.trainedThrough === through
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
}
