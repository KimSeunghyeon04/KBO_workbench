import type {
  BattingStatisticsTotals,
  BattingStatisticsRow,
  PitchingStatisticsTotals,
  PitchingStatisticsRow,
} from "@kbo/contracts";
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
export function battingStatistics(row: BattingStatisticsTotals): BattingStatisticsRow {
  const totalBases = row.hits + row.doubles + 2 * row.triples + 3 * row.homeRuns;
  const obpDenominator = row.atBats + row.walks + row.hitByPitch + row.sacrificeFlies;
  const obp = ratio(row.hits + row.walks + row.hitByPitch, obpDenominator),
    slg = ratio(totalBases, row.atBats);
  return {
    ...row,
    totalBases,
    obpDenominator,
    avg: ratio(row.hits, row.atBats),
    obp,
    slg,
    ops: obp === null || slg === null ? null : obp + slg,
    kRate: ratio(row.strikeouts, row.plateAppearances),
    bbRate: ratio(row.walks, row.plateAppearances),
  };
}
export function pitchingStatistics(row: PitchingStatisticsTotals): PitchingStatisticsRow {
  const knownGamesEra = ratio(row.knownEarnedRuns * 27, row.knownErOuts);
  const kRate = ratio(row.strikeouts, row.battersFaced),
    bbRate = ratio(row.walks, row.battersFaced);
  return {
    ...row,
    era: row.knownErGames === row.games ? knownGamesEra : null,
    knownGamesEra,
    kRate,
    bbRate,
    kMinusBbRate: kRate === null || bbRate === null ? null : kRate - bbRate,
  };
}
