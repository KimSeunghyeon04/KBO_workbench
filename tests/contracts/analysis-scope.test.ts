import { describe, expect, it } from "vitest";
import { AnalysisScopeQuerySchema, resolveAnalysisScope, inAnalysisPeriod } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
describe("analysis scope", () => {
  it("defaults to the regular season and accepts only one competition", () => {
    expect(resolveAnalysisScope({ season: 2025 })).toEqual({
      season: 2025,
      competition: "regular",
      dateFrom: null,
      dateTo: null,
    });
    expect(resolveAnalysisScope({ season: 2025, competition: "postseason" }).competition).toBe(
      "postseason",
    );
    expect(resolveAnalysisScope({ season: 2025, competition: "allstar" }).competition).toBe(
      "allstar",
    );
    expect(Value.Check(AnalysisScopeQuerySchema, { season: 2025, competition: "all" })).toBe(false);
  });
  it("rejects impossible, reversed and cross-season dates; both boundaries are included", () => {
    for (const dates of [
      { dateFrom: "2025-02-29" },
      { dateTo: "2024-12-31" },
      { dateFrom: "2025-06-02", dateTo: "2025-06-01" },
    ])
      expect(() => resolveAnalysisScope({ season: 2025, ...dates })).toThrow();
    const scope = resolveAnalysisScope({
      season: 2024,
      dateFrom: "2024-02-29",
      dateTo: "2024-06-01",
    });
    expect(inAnalysisPeriod("2024-02-29", scope)).toBe(true);
    expect(inAnalysisPeriod("2024-06-01", scope)).toBe(true);
    expect(inAnalysisPeriod("2024-06-02", scope)).toBe(false);
  });
});
