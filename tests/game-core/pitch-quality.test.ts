import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchQualityModelSchema,
  PitchQualityResponseSchema,
  resolveAnalysisScope,
} from "@kbo/contracts";
import { trainPitchQuality, summarizePitchQuality } from "@kbo/game-core";
import { qualityRows, qualityProfiles } from "../helpers/pitch-quality.js";
import { fitBinaryLogit, binaryPredict } from "../../packages/game-core/src/binary-logit.js";
describe("time-split pitch quality", () => {
  it("uses identical evaluation cohorts, conditional denominators and no future preprocessing", () => {
    const rows = qualityRows(),
      model = trainPitchQuality(rows, qualityProfiles(), "a".repeat(64));
    expect(Value.Check(PitchQualityModelSchema, model)).toBe(true);
    expect(model.targets.some((m) => m.adopted)).toBe(true);
    for (const target of model.targets) {
      const baseline = target.validation[0];
      for (const v of target.validation)
        expect(v.evaluations.map((e) => [e.samples, e.coverage])).toEqual(
          baseline?.evaluations.map((e) => [e.samples, e.coverage]),
        );
    }
    const changed = trainPitchQuality(
      rows.map((r) =>
        r.season === 2025
          ? {
              ...r,
              swing: !r.swing,
              whiff: false,
              calledStrike: false,
              crossPlateX: 20,
              speedKph: 250,
            }
          : r,
      ),
      qualityProfiles(),
      "b".repeat(64),
    );
    expect(changed.preprocessing).toEqual(model.preprocessing);
    expect(changed.validationPreprocessing).toEqual(model.validationPreprocessing);
    expect(changed.targets.map((m) => [m.fitted, m.validation, m.adopted])).toEqual(
      model.targets.map((m) => [m.fitted, m.validation, m.adopted]),
    );
    const selected = rows.filter((r) => r.season === 2025),
      response = summarizePitchQuality(
        selected,
        resolveAnalysisScope({ season: 2025, competition: "regular" }),
        "p",
        "c".repeat(64),
        model,
        "d".repeat(64),
      );
    expect(Value.Check(PitchQualityResponseSchema, response)).toBe(true);
    expect(response.coverage.used).toBe(selected.length);
    expect(response.groups.reduce((n, g) => n + g.whiff.samples, 0)).toBe(
      selected.filter((r) => r.swing).length,
    );
    expect(response.groups.reduce((n, g) => n + g.calledStrike.samples, 0)).toBe(
      selected.filter((r) => !r.swing).length,
    );
    const unsupported = summarizePitchQuality(
      selected
        .slice(0, 4)
        .map((r, i) =>
          i === 0
            ? { ...r, eligible: false }
            : i === 1
              ? { ...r, crossPlateX: null }
              : i === 2
                ? { ...r, parkId: "new-park" }
                : { ...r, speedKph: 300 },
        ),
      response.scope,
      "p",
      "c".repeat(64),
      model,
      "d".repeat(64),
    );
    const extreme = selected[0];
    if (extreme === undefined) throw new Error("Missing evaluation input");
    expect(
      summarizePitchQuality(
        [{ ...extreme, crossPlateX: 1e200 }],
        response.scope,
        "p",
        "c".repeat(64),
        model,
        "d".repeat(64),
      ).coverage.missing,
    ).toBe(1);
    expect(unsupported.coverage).toMatchObject({
      actual: 4,
      ineligible: 1,
      missing: 1,
      calibrationUnsupported: 1,
      outOfSupport: 1,
      used: 0,
    });
  }, 30000);
  it("refuses unsupported calibration and never imputes a missing location as center", () => {
    const rows = qualityRows([2020, 2025]).slice(0, 20),
      model = trainPitchQuality(rows, [], "a".repeat(64));
    expect(model.targets.every((m) => !m.adopted)).toBe(true);
    expect(model.preprocessing.reference).toBeNull();
    expect(trainPitchQuality([...rows].reverse(), [], "a".repeat(64))).toEqual(model);
    expect(
      summarizePitchQuality(
        rows,
        resolveAnalysisScope({ season: 2020, competition: "all" }),
        "p",
        "a".repeat(64),
        model,
        "b".repeat(64),
      ).status,
    ).toBe("scope_mismatch");
  });
  it("stays finite under separation, rejects single classes and reports nonconvergence", () => {
    const design = { values: Float64Array.from([1, -5, 1, -3, 1, 3, 1, 5]), width: 2 },
      labels = Uint8Array.from([0, 0, 1, 1]),
      indices = Uint32Array.from([0, 1, 2, 3]);
    const fit = fitBinaryLogit(design, labels, indices, 0.1);
    expect(fit.converged).toBe(true);
    expect(binaryPredict(design, 3, fit.coefficients)).toBeGreaterThan(0.9);
    expect(fitBinaryLogit(design, new Uint8Array(4), indices, 0.1).converged).toBe(false);
    expect(fitBinaryLogit(design, labels, indices, 0.1, 0).converged).toBe(false);
  });
});
