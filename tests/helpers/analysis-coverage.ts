import type { AnalysisCoverageResponse } from "@kbo/contracts";
import type { CoverageSeason } from "@kbo/persistence";

export function coverageSeasonFixture(): CoverageSeason {
  const response = coverageFixture();
  return {
    version: 1,
    sourceKey: "c".repeat(64),
    referenceHash: "d".repeat(64),
    calibrationHash: response.calibrationHash,
    scope: response.scope,
    games: [
      {
        game: {
          gameId: "game-1",
          revision: 1,
          documentHash: "e".repeat(64),
          gameDate: "2025-06-01",
          stadium: "잠실",
          competition: "unknown",
          actualPitches: 4,
          withPitchType: 4,
          withSpeed: 4,
          zoneKnown: 0,
          completedPlateAppearances: 1,
        },
        counts: response.total,
      },
    ],
  };
}

export function coverageFixture(season = 2025): AnalysisCoverageResponse {
  const counts = {
    games: 1,
    actualPitches: 4,
    completedPlateAppearances: 1,
    withPitchType: 4,
    withSpeed: 4,
    zoneKnown: 0,
    linkedTracking: 3,
    missingTracking: 1,
    invalidTrajectory: 1,
    validTrajectory: 2,
    calibratedTrajectory: 0,
    insufficientCalibration: 2,
    unsupportedPark: 0,
  };
  return {
    version: 1,
    season,
    sourceHash: "a".repeat(64),
    calibrationHash: "b".repeat(64),
    scope: { season, competition: "all", dateFrom: null, dateTo: null },
    competitions: [
      { competition: "preseason", games: 0 },
      { competition: "regular", games: 0 },
      { competition: "postseason", games: 0 },
      { competition: "unknown", games: 1 },
    ],
    unclassifiedGames: 1,
    firstGameDate: `${season}-06-01`,
    lastGameDate: `${season}-06-01`,
    total: counts,
    stadiums: [{ stadium: "잠실", counts: { ...counts } }],
  };
}
