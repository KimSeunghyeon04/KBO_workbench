import type { PitchQualityRow, PitchQualityPreprocessing } from "@kbo/contracts";
import { disciplineRow } from "./batter-discipline.js";
export function qualityRows(seasons = [2020, 2021, 2022, 2023, 2024, 2025]): PitchQualityRow[] {
  let state = 97121;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const rows: PitchQualityRow[] = [];
  for (const season of seasons)
    for (let game = 0; game < 40; game++)
      for (let pitch = 0; pitch < 30; pitch++) {
        const x = ((pitch % 10) - 4.5) / 3,
          z = ((pitch % 7) - 3) / 3,
          speed = 130 + (pitch % 11) * 2,
          swing = random() < (Math.abs(x) < 0.85 ? 0.92 : 0.08),
          whiff = swing && random() < (speed > 140 ? 0.8 : 0.1);
        rows.push({
          ...disciplineRow({
            season,
            gameId: `g-${season}-${game}`,
            pitchId: `p-${pitch}`,
            trackingId: `t-${pitch}`,
            gameDate: `${season}-07-${String(1 + (game % 28)).padStart(2, "0")}`,
            x0: 0,
            z0: 2.6 + z * 0.4 - (season >= 2025 ? 1.08 / 30.48 : 0),
            ax: Math.sin(pitch) * 8,
            ay: 0,
            vy0: -speed / 1.09728,
            speedKph: speed,
            balls: game % 4,
            strikes: game % 3,
            stance: game % 2 === 0 ? "L" : "R",
            pitchType: pitch % 3 === 0 ? "슬라이더" : "직구",
            crossPlateX: x,
            whiff,
            swing,
          }),
          pitcherId: `pitcher-${game % 10}`,
          stadium: "잠실",
          parkId: "jamsil",
          calledStrike: !swing && random() < (Math.abs(x) < 0.85 ? 0.95 : 0.05),
        });
      }
  return rows;
}
export function qualityProfiles(): PitchQualityPreprocessing["profiles"] {
  return [2020, 2021, 2022, 2023, 2024].map((season) => ({
    season,
    profile: {
      asOf: `${season}-08-01`,
      windowStart: `${season}-05-09`,
      inputHash: "c".repeat(64),
      status: "ready",
      lastTrainingDate: `${season}-07-28`,
      trainingCells: 100,
      trainingGames: 40,
      trainingPitchers: 30,
      coefficients: [
        {
          parkId: "jamsil",
          lateralBias: 0,
          verticalBias: 0,
          lateralStandardError: 0,
          verticalStandardError: 0,
          games: 40,
          pitchers: 30,
          pitches: 1200,
          cells: 100,
        },
      ],
      covariance: [
        [0, 0],
        [0, 0],
      ],
    },
  }));
}
