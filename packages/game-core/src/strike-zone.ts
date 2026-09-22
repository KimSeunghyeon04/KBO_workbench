import type { BatterStrikeZone } from "@kbo/contracts";

export const STRIKE_ZONE_HALF_WIDTH_FEET = 47.18 / 2 / 30.48;

/** Product policy: pre-ABS seasons use 2024; 2025–2026 use 2025. No provider fallback. */
export function resolveBatterStrikeZone(
  season: number,
  batterHeightCm: number | null,
): BatterStrikeZone | null {
  if (
    !Number.isInteger(season) ||
    season < 1982 ||
    season > 2026 ||
    batterHeightCm === null ||
    !Number.isInteger(batterHeightCm) ||
    batterHeightCm < 100 ||
    batterHeightCm > 250
  )
    return null;
  const ruleYear = season <= 2024 ? 2024 : 2025;
  return {
    ruleYear,
    batterHeightCm,
    topFeet: (batterHeightCm * (ruleYear === 2024 ? 0.5635 : 0.5575)) / 30.48,
    bottomFeet: (batterHeightCm * (ruleYear === 2024 ? 0.2764 : 0.2704)) / 30.48,
    halfWidthFeet: STRIKE_ZONE_HALF_WIDTH_FEET,
  };
}
