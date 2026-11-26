import { expect, it } from "vitest";
import { battingStatistics, pitchingStatistics, summarizePlayerSplits } from "@kbo/game-core";
import { battingTotals, pitchingTotals } from "../helpers/player-statistics.js";
it("counts intentional walks and sacrifices in their proper split denominators", () => {
  const rows = summarizePlayerSplits(
    ["L", "R", "unknown"],
    [
      { bucket: "L", result: "double", countsAsAtBat: true },
      { bucket: "L", result: "intentional_walk", countsAsAtBat: false },
      { bucket: "L", result: "sacrifice_fly", countsAsAtBat: false },
      { bucket: "unknown", result: "strikeout", countsAsAtBat: true },
    ],
  );
  expect(rows).toMatchObject([
    {
      bucket: "L",
      plateAppearances: 3,
      atBats: 1,
      hits: 1,
      walks: 1,
      intentionalWalks: 1,
      totalBases: 2,
      obpDenominator: 3,
      avg: 1,
      obp: 2 / 3,
      slg: 2,
    },
    { bucket: "R", plateAppearances: 0, atBats: 0, avg: null, obp: null, ops: null },
    { bucket: "unknown", plateAppearances: 1, atBats: 1, strikeouts: 1, avg: 0, ops: 0 },
  ]);
});
it("calculates batting ratios from their distinct summed denominators", () => {
  expect(battingStatistics(battingTotals)).toMatchObject({
    totalBases: 6,
    avg: 0.4,
    obp: 0.5,
    slg: 1.2,
    ops: 1.7,
    kRate: 0.125,
    bbRate: 0.125,
  });
  expect(
    battingStatistics({
      ...battingTotals,
      atBats: 0,
      plateAppearances: 0,
      walks: 0,
      hitByPitch: 0,
      sacrificeFlies: 0,
    }),
  ).toMatchObject({ avg: null, obp: null, slg: null, ops: null, kRate: null, bbRate: null });
});
it("never turns missing ER into an all-game ERA or counts unknown innings in the known-game denominator", () => {
  expect(pitchingStatistics(pitchingTotals)).toMatchObject({
    era: null,
    knownGamesEra: 3,
    kRate: 0.2,
    bbRate: 0.05,
  });
  expect(
    pitchingStatistics({ ...pitchingTotals, knownErGames: 2, knownErOuts: 27, knownEarnedRuns: 3 })
      .era,
  ).toBe(3);
  expect(
    pitchingStatistics({
      ...pitchingTotals,
      knownErGames: 0,
      knownErOuts: 0,
      knownEarnedRuns: 0,
      battersFaced: 0,
    }),
  ).toMatchObject({
    era: null,
    knownGamesEra: null,
    kRate: null,
    bbRate: null,
    kMinusBbRate: null,
  });
});
