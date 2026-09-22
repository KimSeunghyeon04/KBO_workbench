import {
  PITCH_CALIBRATION_PARAMETERS,
  type PitchQualityRow,
  type PitchQualityPreprocessing,
} from "@kbo/contracts";
import { fitPitchCalibration, trainPitchQuality } from "@kbo/game-core";
import { preparePitchCalibrationCells, pitchCalibrationHash } from "./pitch-calibration.js";
import { standardAnalysisVenueIds } from "./analysis-venues.js";
/** Frozen preprocessing is fitted entirely inside each historical training season. */
export function trainPitchQualityFromFacts(
  rows: readonly PitchQualityRow[],
  sourceHash: string,
  through: number,
) {
  const profiles: PitchQualityPreprocessing["profiles"] = [];
  for (let season = 2020; season <= through; season++) {
    const seasonRows = rows.filter((r) => r.season === season),
      last = seasonRows.reduce((date, r) => (r.gameDate > date ? r.gameDate : date), "");
    if (last === "") continue;
    const asOf = new Date(Date.parse(`${last}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
      cells = preparePitchCalibrationCells(seasonRows),
      parks = standardAnalysisVenueIds(season);
    const profile = {
      ...fitPitchCalibration(cells, asOf, parks, "jamsil"),
      inputHash: pitchCalibrationHash({
        parameters: PITCH_CALIBRATION_PARAMETERS,
        season,
        asOf,
        parks,
        cells,
      }),
    };
    profiles.push({ season, profile });
  }
  return trainPitchQuality(rows, profiles, sourceHash, through);
}
