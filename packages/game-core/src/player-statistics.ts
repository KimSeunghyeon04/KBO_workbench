import type {
  BattingStatisticsTotals,
  BattingStatisticsRow,
  PitchingStatisticsTotals,
  PitchingStatisticsRow,
  PlateResult,
  PlayerSplitBucket,
  PlayerSplitResponse,
} from "@kbo/contracts";
import { isHit } from "./rules.js";
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
type StatisticsIdentity = "identity" | "playerId" | "name" | "teamId" | "teamName";
type BattingRateInputs = Pick<
  BattingStatisticsTotals,
  | "hits"
  | "doubles"
  | "triples"
  | "homeRuns"
  | "atBats"
  | "walks"
  | "hitByPitch"
  | "sacrificeFlies"
  | "plateAppearances"
  | "strikeouts"
>;
export function battingStatistics<T extends BattingRateInputs>(
  row: T,
): T & Omit<BattingStatisticsRow, keyof BattingStatisticsTotals> {
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

export function plateResultCounts(result: PlateResult) {
  return {
    hits: Number(isHit(result)),
    doubles: Number(result === "double"),
    triples: Number(result === "triple"),
    homeRuns: Number(result === "home_run"),
    walks: Number(result === "walk" || result === "intentional_walk"),
    intentionalWalks: Number(result === "intentional_walk"),
    hitByPitch: Number(result === "hit_by_pitch"),
    strikeouts: Number(result === "strikeout"),
    sacrificeBunts: Number(result === "sacrifice_bunt"),
    sacrificeFlies: Number(result === "sacrifice_fly"),
  };
}

export function summarizeBattingResults(
  appearances: readonly { result: PlateResult; countsAsAtBat: boolean }[],
) {
  const totals = {
    plateAppearances: 0,
    atBats: 0,
    hits: 0,
    doubles: 0,
    triples: 0,
    homeRuns: 0,
    walks: 0,
    intentionalWalks: 0,
    hitByPitch: 0,
    strikeouts: 0,
    sacrificeBunts: 0,
    sacrificeFlies: 0,
  };
  for (const appearance of appearances) {
    const counts = plateResultCounts(appearance.result);
    totals.plateAppearances++;
    totals.atBats += Number(appearance.countsAsAtBat);
    totals.hits += counts.hits;
    totals.doubles += counts.doubles;
    totals.triples += counts.triples;
    totals.homeRuns += counts.homeRuns;
    totals.walks += counts.walks;
    totals.intentionalWalks += counts.intentionalWalks;
    totals.hitByPitch += counts.hitByPitch;
    totals.strikeouts += counts.strikeouts;
    totals.sacrificeBunts += counts.sacrificeBunts;
    totals.sacrificeFlies += counts.sacrificeFlies;
  }
  return battingStatistics(totals);
}
export function summarizePlayerSplits(
  buckets: readonly PlayerSplitBucket[],
  appearances: readonly {
    bucket: PlayerSplitBucket;
    result: PlateResult;
    countsAsAtBat: boolean;
  }[],
): PlayerSplitResponse["rows"] {
  return buckets.map((bucket) => ({
    bucket,
    ...summarizeBattingResults(appearances.filter((appearance) => appearance.bucket === bucket)),
  }));
}
export function pitchingStatistics<T extends Omit<PitchingStatisticsTotals, StatisticsIdentity>>(
  row: T,
): T & Omit<PitchingStatisticsRow, keyof PitchingStatisticsTotals> {
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
