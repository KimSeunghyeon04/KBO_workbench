import type { PitchQualityFit, PitchQualityPreprocessing } from "@kbo/contracts";
import { binaryPredict, type BinaryDesign } from "./binary-logit.js";
import { qualityDesign, type QualitySample } from "./pitch-quality-features.js";

export function qualityOutcome(
  sample: QualitySample,
  target: PitchQualityFit["target"],
): number | null {
  const r = sample.row;
  return target === "swing"
    ? Number(r.swing)
    : target === "whiff"
      ? r.swing
        ? Number(r.whiff)
        : null
      : r.swing
        ? null
        : Number(r.calledStrike);
}
export function qualityPredictor(model: PitchQualityFit, design: BinaryDesign | null) {
  const cells = new Map(model.cells.map((c) => [c.key, c.probability]));
  return (s: QualitySample, i: number) =>
    model.kind === "baseline"
      ? (cells.get(s.key) ?? model.prior)
      : design === null || !model.converged
        ? model.prior
        : binaryPredict(design, i, model.coefficients);
}
/** Materialize each requested design once; unadopted targets need no matrix. */
export function prepareQualityPredictors(
  samples: readonly QualitySample[],
  preprocessing: PitchQualityPreprocessing,
  fits: readonly (PitchQualityFit | null)[],
) {
  const designs = new Map<"shape" | "location", BinaryDesign>();
  return fits.map((fit) => {
    if (fit === null) return null;
    if (fit.kind === "baseline") return qualityPredictor(fit, null);
    let design = designs.get(fit.kind);
    if (design === undefined) {
      design = qualityDesign(samples, preprocessing, fit.kind);
      designs.set(fit.kind, design);
    }
    return qualityPredictor(fit, design);
  });
}
