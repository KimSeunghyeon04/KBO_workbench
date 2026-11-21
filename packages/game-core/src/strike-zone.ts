import type { BatterStrikeZone } from "@kbo/contracts";

export const STRIKE_ZONE_HALF_WIDTH_FEET = 47.18 / 2 / 30.48;

// Effective seasons descend so each rule stays in force until the next one.
const strikeZoneRules = [
  { fromSeason: 2025, ruleYear: 2025, top: 0.5575, bottom: 0.2704 },
  { fromSeason: 1982, ruleYear: 2024, top: 0.5635, bottom: 0.2764 },
] as const;

export function resolveBatterStrikeZone(
  season: number,
  batterHeightCm: number | null,
): BatterStrikeZone | null {
  if (
    !Number.isInteger(season) ||
    season > 9999 ||
    batterHeightCm === null ||
    !Number.isInteger(batterHeightCm) ||
    batterHeightCm < 100 ||
    batterHeightCm > 250
  )
    return null;
  const rule = strikeZoneRules.find(({ fromSeason }) => fromSeason <= season);
  if (rule === undefined) return null;
  return {
    ruleYear: rule.ruleYear,
    batterHeightCm,
    topFeet: (batterHeightCm * rule.top) / 30.48,
    bottomFeet: (batterHeightCm * rule.bottom) / 30.48,
    halfWidthFeet: STRIKE_ZONE_HALF_WIDTH_FEET,
  };
}
