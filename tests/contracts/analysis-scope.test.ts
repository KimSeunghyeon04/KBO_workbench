import { describe, expect, it } from "vitest";
import { resolveAnalysisScope, inAnalysisPeriod } from "@kbo/contracts";
describe("analysis scope", () => {
  it("keeps the established collected scope explicit and permits a regular-only default", () => {
    expect(resolveAnalysisScope({ season: 2025 })).toEqual({
      season: 2025,
      competition: "all",
      dateFrom: null,
      dateTo: null,
    });
    expect(resolveAnalysisScope({ season: 2025 }, "regular").competition).toBe("regular");
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
