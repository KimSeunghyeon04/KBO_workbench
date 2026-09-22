import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveBatterStrikeZone } from "@kbo/game-core";

describe("height-only strike zone policy", () => {
  it.each([1982, 2020, 2023, 2024, 2025, 2026])("season %i uses the explicit rule year", (year) => {
    const zone = resolveBatterStrikeZone(year, 180);
    const old = year <= 2024;
    expect(zone).toEqual({
      ruleYear: old ? 2024 : 2025,
      batterHeightCm: 180,
      topFeet: (180 * (old ? 0.5635 : 0.5575)) / 30.48,
      bottomFeet: (180 * (old ? 0.2764 : 0.2704)) / 30.48,
      halfWidthFeet: 47.18 / 2 / 30.48,
    });
  });
  it("does not invent height or a rule for an unconfigured season", () => {
    for (const h of [null, NaN, Infinity, 0, 99, 251, 180.5])
      expect(resolveBatterStrikeZone(2024, h)).toBeNull();
    expect(resolveBatterStrikeZone(2027, 180)).toBeNull();
  });
  it("height scales vertical bounds and leaves width unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 250 }), (h) => {
        const a = resolveBatterStrikeZone(2024, h),
          b = resolveBatterStrikeZone(2025, h);
        if (a === null || b === null) throw new Error("valid height");
        expect(a.topFeet - a.bottomFeet).toBeCloseTo(b.topFeet - b.bottomFeet, 12);
        expect(a.topFeet - b.topFeet).toBeCloseTo((h * 0.006) / 30.48, 12);
        expect(a.halfWidthFeet).toBe(b.halfWidthFeet);
        expect(resolveBatterStrikeZone(2026, h)).toEqual(b);
      }),
    );
  });
});
