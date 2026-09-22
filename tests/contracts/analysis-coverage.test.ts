import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisCoverageResponseSchema,
  AnalysisCoverageResultSchema,
  validAnalysisCoverage,
} from "@kbo/contracts";
import { coverageFixture } from "../helpers/analysis-coverage.js";

describe("analysis coverage conservation", () => {
  it("keeps preparation states strict and separate from numeric results", () => {
    const state = { state: "preparing", sourceKey: "a".repeat(64), scope: coverageFixture().scope };
    expect(Value.Check(AnalysisCoverageResultSchema, state)).toBe(true);
    expect(Value.Check(AnalysisCoverageResultSchema, { ...state, state: "failed" })).toBe(true);
    expect(Value.Check(AnalysisCoverageResultSchema, { ...state, state: "ready" })).toBe(false);
    expect(
      Value.Check(AnalysisCoverageResultSchema, { ...state, total: coverageFixture().total }),
    ).toBe(false);
  });
  it("separates field presence, valid geometry and calibration without multiplying PA", () => {
    const value = coverageFixture();
    expect(Value.Check(AnalysisCoverageResponseSchema, value)).toBe(true);
    expect(validAnalysisCoverage(value)).toBe(true);
    value.total.completedPlateAppearances++;
    expect(validAnalysisCoverage(value)).toBe(false);
  });
  it("rejects missing/invalid/calibrated double counting and duplicate stadium rows", () => {
    const value = coverageFixture();
    const first = value.stadiums[0];
    if (first === undefined) throw new Error("missing stadium");
    value.total.validTrajectory++;
    first.counts.validTrajectory++;
    expect(validAnalysisCoverage(value)).toBe(false);
    const duplicate = coverageFixture();
    duplicate.stadiums.push(...structuredClone(duplicate.stadiums));
    expect(validAnalysisCoverage(duplicate)).toBe(false);
  });
});
