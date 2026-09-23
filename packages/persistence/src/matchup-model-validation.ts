import { modelValidationSeasons, validModelEvaluationSeasons } from "@kbo/game-core";
import type { MatchupModel } from "@kbo/contracts";
import { pitchQualitySourceHash, type PitchQualityManifest } from "./pitch-quality-manifest.js";
import { validPitchQualityModel } from "./pitch-quality-model-validation.js";

export function validMatchupModel(model: MatchupModel, manifest: PitchQualityManifest) {
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
