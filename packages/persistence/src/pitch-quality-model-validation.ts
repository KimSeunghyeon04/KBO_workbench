import { modelTrainingPeriod, validModelEvaluationSeasons } from "@kbo/game-core";
import type { PitchQualityModel } from "@kbo/contracts";
import { pitchQualitySourceHash, type PitchQualityManifest } from "./pitch-quality-manifest.js";

export function validPitchQualityModel(model: PitchQualityModel, manifest: PitchQualityManifest) {
  const p = model.preprocessing;
  if (
    modelTrainingPeriod("quality", model.trainedThrough + 1).support !== "eligible" ||
    !validModelEvaluationSeasons(model.trainedThrough, model.validationPreprocessing) ||
    model.targets.some(
      (target) =>
        (target.evaluation !== null && target.evaluation.season !== model.trainedThrough + 1) ||
        target.validation.some(
          (candidate) => !validModelEvaluationSeasons(model.trainedThrough, candidate.evaluations),
        ),
    ) ||
    model.sourceHash !== pitchQualitySourceHash(manifest) ||
    model.trainedThrough !== manifest.through ||
    p.through !== model.trainedThrough ||
    p.referenceHash !== pitchQualitySourceHash(p.reference)
  )
    return false;
  if (
    ![p.means, p.scales, p.minima, p.maxima].every((v) => v.length === 9) ||
    p.scales.some((s) => s <= 0) ||
    p.minima.some((v, i) => v > (p.maxima[i] ?? -Infinity))
  )
    return false;
  if (
    new Set(p.profiles.map((v) => v.season)).size !== p.profiles.length ||
    p.profiles.some(
      (v) =>
        v.season > p.through ||
        !v.profile.asOf.startsWith(`${v.season}-`) ||
        (v.profile.lastTrainingDate !== null && v.profile.lastTrainingDate >= v.profile.asOf),
    )
  )
    return false;
  return model.targets.every(
    (m, i) =>
      m.target === ["swing", "whiff", "called_strike"][i] &&
      m.target === m.fitted.target &&
      m.fitted.positives <= m.fitted.samples &&
      (m.fitted.kind === "baseline"
        ? m.fitted.coefficients.length === 0 &&
          m.fitted.cells.reduce((s, c) => s + c.samples, 0) === m.fitted.samples
        : m.fitted.coefficients.length ===
          1 + p.pitchTypes.length + p.stances.length + 12 + (m.fitted.kind === "shape" ? 4 : 9)) &&
      (!m.adopted ||
        (m.fitted.converged &&
          m.fitted.kind !== "baseline" &&
          m.validation.some(
            (v) =>
              v.kind === m.fitted.kind &&
              v.lambda === m.fitted.lambda &&
              v.converged &&
              v.subgroupGate &&
              v.evaluations.length === 2 &&
              v.lossDifference95 !== null &&
              v.lossDifference95.high < 0,
          ))),
  );
}
