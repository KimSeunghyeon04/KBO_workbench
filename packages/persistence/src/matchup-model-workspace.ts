import { Type } from "@sinclair/typebox";
import { modelValidationSeasons, validModelEvaluationSeasons } from "@kbo/game-core";
import { MatchupModelSchema, type MatchupModel } from "@kbo/contracts";
import { readAnalysisModelFile, writeAnalysisModelFile } from "./analysis-model-files.js";
import {
  PitchQualityManifestSchema,
  pitchQualitySourceHash,
  type PitchQualityManifest,
} from "./pitch-quality-repository.js";
import { validPitchQualityModel } from "./pitch-quality-workspace.js";
const envelope = Type.Object(
  { model: MatchupModelSchema, manifest: PitchQualityManifestSchema },
  { additionalProperties: false },
);
function valid(model: MatchupModel, manifest: PitchQualityManifest) {
  if (
    !validModelEvaluationSeasons(model.trainedThrough, model.validationPreprocessing) ||
    model.targets.some(
      (target) =>
        (target.evaluation !== null && target.evaluation.season !== model.trainedThrough + 1) ||
        target.validation.some(
          (candidate) => !validModelEvaluationSeasons(model.trainedThrough, candidate.evaluations),
        ),
    ) ||
    model.similarity.validation.some(
      (candidate) => !validModelEvaluationSeasons(model.trainedThrough, candidate.evaluations),
    ) ||
    !validPitchQualityModel(model.base, manifest) ||
    model.sourceHash !== model.base.sourceHash ||
    model.trainedThrough !== model.base.trainedThrough ||
    model.baseModelHash !== pitchQualitySourceHash({ model: model.base, manifest }) ||
    ![0.5, 1, 1.5].includes(model.similarity.radius)
  )
    return false;
  if (
    model.similarity.validatedImprovement &&
    !model.similarity.validation.some(
      (v) =>
        v.parameter === model.similarity.radius &&
        v.subgroupGate &&
        v.evaluations.length === 2 &&
        v.lossDifference95 !== null &&
        v.lossDifference95.high < 0,
    )
  )
    return false;
  return model.targets.every((m, i) => {
    const parent = model.base.targets[i],
      parentValidation = parent?.validation.find(
        (v) => v.kind === parent.fitted.kind && v.lambda === parent.fitted.lambda,
      );
    return (
      m.target === parent?.target &&
      [20, 100, 500].includes(m.penalty) &&
      new Set(m.effects.map((e) => e.batterId)).size === m.effects.length &&
      m.effects.every((e) => e.games <= e.samples && Math.abs(e.offset) <= 50) &&
      (!m.adopted ||
        (parent.adopted &&
          m.validation.some(
            (v) =>
              v.parameter === m.penalty &&
              v.subgroupGate &&
              v.evaluations.length === 2 &&
              v.lossDifference95 !== null &&
              v.lossDifference95.high < 0 &&
              v.evaluations.every(
                (e, j) =>
                  e.season === modelValidationSeasons(model.trainedThrough)[j] &&
                  e.logLoss !== null &&
                  e.logLoss < (parentValidation?.evaluations[j]?.logLoss ?? -Infinity),
              ),
          )))
    );
  });
}
export class MatchupModelWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public async save(model: MatchupModel, manifest: PitchQualityManifest, signal?: AbortSignal) {
    if (!valid(model, manifest)) throw new Error("Invalid matchup model provenance or validation");
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
        valid(result.payload.model, result.payload.manifest)
        ? { model: result.payload.model, hash: result.hash }
        : null;
    } catch {
      return null;
    }
  }
}
