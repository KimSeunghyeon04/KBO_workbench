import { afterEach, describe, expect, it, vi } from "vitest";
import type { PitchQualityFit } from "@kbo/contracts";
import * as features from "../../packages/game-core/src/pitch-quality-features.js";
import {
  prepareQualityPredictors,
  qualityOutcome,
  qualityPredictor,
} from "../../packages/game-core/src/pitch-quality-target.js";
import { qualityProfiles, qualityRows } from "../helpers/pitch-quality.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const rows = features.prepareQualityRows(qualityRows([2024]));
  const preprocessing = features.fitQualityPreprocessing(rows, qualityProfiles(), 2024);
  return { preprocessing, ...features.qualityCohort(rows, preprocessing) };
}

function fitted(kind: PitchQualityFit["kind"], target: PitchQualityFit["target"]): PitchQualityFit {
  return {
    kind,
    target,
    lambda: 1,
    converged: true,
    samples: 1000,
    positives: 400,
    prior: 0.4,
    cells: [],
    coefficients: [0.2, 0.3, -0.1],
  };
}

describe("prepared quality prediction", () => {
  it("keeps conditional outcome denominators separate for swing, whiff and called strike", () => {
    const sample = fixture().samples[0];
    if (sample === undefined) throw new Error("Missing sample");
    const swing = {
      ...sample,
      row: { ...sample.row, swing: true, whiff: true, calledStrike: false },
    };
    const take = {
      ...sample,
      row: { ...sample.row, swing: false, whiff: false, calledStrike: true },
    };
    const targets = ["swing", "whiff", "called_strike"] as const;
    expect(targets.map((target) => qualityOutcome(swing, target))).toEqual([1, 1, null]);
    expect(targets.map((target) => qualityOutcome(take, target))).toEqual([0, null, 1]);
  });

  it("allocates no design matrix for unavailable targets or a baseline prediction", () => {
    const { samples, preprocessing } = fixture();
    const design = vi.spyOn(features, "qualityDesign");
    const predictions = prepareQualityPredictors(samples, preprocessing, [
      null,
      fitted("baseline", "whiff"),
      null,
    ]);
    expect(design).not.toHaveBeenCalled();
    expect(predictions[0]).toBeNull();
    expect(predictions[2]).toBeNull();
    const sample = samples[0];
    if (sample === undefined) throw new Error("Missing sample");
    expect(predictions[1]?.(sample, 0)).toBe(0.4);
  });

  it("shares one matrix per requested feature kind without changing probabilities or inputs", () => {
    const { samples, preprocessing } = fixture();
    const fits = [
      fitted("shape", "swing"),
      fitted("shape", "whiff"),
      fitted("location", "called_strike"),
    ];
    const before = structuredClone({ samples, preprocessing, fits });
    const expected = fits.map((fit) => {
      if (fit.kind === "baseline") throw new Error("Expected feature model");
      const predict = qualityPredictor(
        fit,
        features.qualityDesign(samples, preprocessing, fit.kind),
      );
      return samples.map(predict);
    });
    const design = vi.spyOn(features, "qualityDesign");
    const predictions = prepareQualityPredictors(samples, preprocessing, fits);
    expect(design.mock.calls.map((call) => call[2])).toEqual(["shape", "location"]);
    expect(predictions.map((predict) => samples.map((sample, i) => predict?.(sample, i)))).toEqual(
      expected,
    );
    expect({ samples, preprocessing, fits }).toEqual(before);
  });
});
