import type { PitchAnalysisSample, PitchCalibrationSeason } from "@kbo/contracts";
import type { PitchAnalysisRow } from "@kbo/persistence";

export function calibrationSummary(
  points: number,
  applied = 0,
): PitchAnalysisSample["calibration"] {
  return {
    modelVersion: 1,
    profileHash: "c".repeat(64),
    windowDays: 84,
    halfLifeDays: 7,
    plane: "middle",
    calibratedCount: applied,
    uncalibratedCount: points - applied,
  };
}
export function emptyCalibration(season = 2024): PitchCalibrationSeason {
  return { modelVersion: 1, season, sourceHash: "a".repeat(64), profiles: [] };
}

export function calibrationRows(): PitchAnalysisRow[] {
  const stadiums = ["고척", "광주", "대구", "대전(신)", "문학", "사직", "수원", "잠실", "창원"];
  const result: PitchAnalysisRow[] = [];
  for (let game = 0; game < 45; game++) {
    const gameDate = new Date(Date.UTC(2025, 3, 1 + game)).toISOString().slice(0, 10);
    for (let pitcher = 0; pitcher < 24; pitcher++) {
      for (let type = 0; type < 2; type++) {
        for (let pitch = 0; pitch < 5; pitch++) {
          const index = pitcher * 37 + game * 13 + type * 23 + pitch;
          const vy0 = -132 + Math.sin(index * 0.38) * 8;
          const lateral = ((game % 9) - 4) * 1.3 + (pitcher % 3) - type * 3;
          const vertical = (4 - (game % 9)) * 0.4 - 20 + (pitcher % 4) * 0.2 - type * 4;
          result.push({
            gameId: `game-${String(game).padStart(2, "0")}`,
            revision: 1,
            pitchId: `pitch-${pitcher}-${type}-${pitch}`,
            gameDate,
            pitcherId: `pitcher-${pitcher}`,
            pitchType: type === 0 ? "직구" : "슬라이더",
            stadium: stadiums[game % 9] ?? null,
            stance: index % 3 === 0 ? "L" : "R",
            balls: (pitcher * 7 + game * 3 + type + pitch) % 4,
            strikes: (pitcher * game + type + pitch) % 3,
            speedKph: 145,
            swing: false,
            whiff: false,
            trackingId: `tracking-${pitcher}-${type}-${pitch}`,
            supported: true,
            x0: -1,
            y0: 50,
            z0: 6,
            vx0: 2,
            vy0,
            vz0: -3,
            ax: lateral + (2 / vy0) * 25,
            ay: 25,
            az: vertical - (3 / vy0) * 25,
            crossPlateY: 1.4167,
          });
        }
      }
    }
  }
  const last = result.at(-1);
  if (last === undefined) throw new Error("Missing calibration fixture");
  result.push({ ...last, gameId: "evaluation", gameDate: "2025-05-20", pitchType: "직구" });
  return result;
}
