import type { DisciplineRow, DisciplineSnapshot } from "@kbo/contracts";
import { alignPitchTrajectory, averagePitchTrajectory } from "@kbo/game-core";

export function disciplineRow(overrides: Partial<DisciplineRow> = {}): DisciplineRow {
  return {
    gameId: "test-game",
    revision: 1,
    pitchId: "p1",
    gameDate: "2024-06-01",
    batterId: "b1",
    pitchType: "직구",
    stance: "R",
    speedKph: 145,
    balls: 0,
    strikes: 0,
    swing: false,
    whiff: false,
    eligible: true,
    trackingId: "t1",
    supported: true,
    inZone: true,
    crossPlateX: 0,
    crossPlateY: 1.4167,
    season: 2024,
    batterHeightCm: 180,
    x0: 0,
    y0: 50,
    z0: 2.5,
    vx0: 0,
    vy0: -140,
    vz0: 0,
    ax: 0,
    ay: 0,
    az: 0,
    ...overrides,
  };
}
export function disciplineSnapshot(rows: DisciplineRow[] = [disciplineRow()]): DisciplineSnapshot {
  const sample = alignPitchTrajectory(disciplineRow());
  const trajectory = sample === null ? null : averagePitchTrajectory([sample]);
  if (trajectory === null) throw new Error("Bad discipline fixture");
  return {
    season: 2024,
    sourceHash: "a".repeat(64),
    rows,
    reference: {
      trajectory,
      distribution: null,
      summary: {
        pitchType: "직구",
        sampleCount: 1,
        candidateCount: 1,
        excludedCount: 0,
        arrivalMs: trajectory.arrivalSeconds * 1000,
        speedKphAt50Feet: trajectory.speedKph,
        firstGameDate: "2024-06-01",
        lastGameDate: "2024-06-01",
      },
    },
  };
}
