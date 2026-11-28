import { createHash } from "node:crypto";
import {
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  type PitchCalibrationCoefficient,
  type PitchCalibrationProfile,
  type PitchCalibrationSeason,
  type PitchCalibrationStatus,
} from "@kbo/contracts";
import {
  alignPitchTrajectory,
  fitPitchCalibration,
  pitchCalibrationWindowStart,
  type AlignedPitchTrajectory,
  type PitchCalibrationCell,
} from "@kbo/game-core";
import type { PitchAnalysisRow } from "./pitch-analysis-repository.js";

import {
  analysisVenueId as pitchCalibrationParkId,
  standardAnalysisVenueIds,
} from "./analysis-venues.js";
export { pitchCalibrationParkId };
const universe = standardAnalysisVenueIds;
export const pitchCalibrationHash = (value: unknown): string =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");

export function middlePlaneTrajectory(row: PitchAnalysisRow): AlignedPitchTrajectory | null {
  return row.supported && row.trackingId !== null
    ? alignPitchTrajectory({ ...row, crossPlateY: PITCH_CALIBRATION_PARAMETERS.plateYFeet })
    : null;
}

export function preparePitchCalibrationCells(
  rows: readonly PitchAnalysisRow[],
): PitchCalibrationCell[] {
  type Aggregate = Omit<
    PitchCalibrationCell,
    "count" | "lateral" | "vertical" | "speed" | "left" | "balls" | "strikes"
  > & {
    count: number;
    lateral: number;
    vertical: number;
    speed: number;
    left: number;
    balls: number;
    strikes: number;
  };
  const grouped = new Map<string, Aggregate>();
  const ordered = [...rows].sort((a, b) => {
    for (const key of ["gameId", "pitchId", "trackingId"] as const) {
      const left = a[key] ?? "",
        right = b[key] ?? "";
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
  for (const row of ordered) {
    const parkId = pitchCalibrationParkId(Number(row.gameDate.slice(0, 4)), row.stadium);
    if (row.pitchType === null || parkId === null) continue;
    const trajectory = middlePlaneTrajectory(row);
    if (trajectory === null) continue;
    const key = canonicalStringify([row.gameId, row.pitcherId, row.pitchType]);
    const group = grouped.get(key) ?? {
      gameId: row.gameId,
      gameDate: row.gameDate,
      parkId,
      pitcherId: row.pitcherId,
      pitchType: row.pitchType,
      count: 0,
      lateral: 0,
      vertical: 0,
      speed: 0,
      left: 0,
      balls: 0,
      strikes: 0,
    };
    group.count++;
    group.lateral += trajectory.lateralAcceleration;
    group.vertical += trajectory.verticalAcceleration;
    group.speed += trajectory.speedKph;
    group.left += Number(row.stance === "L");
    group.balls += row.balls;
    group.strikes += row.strikes;
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([, c]) =>
      c.count < PITCH_CALIBRATION_PARAMETERS.minCellPitches
        ? []
        : [
            {
              ...c,
              lateral: c.lateral / c.count,
              vertical: c.vertical / c.count,
              speed: c.speed / c.count,
              left: c.left / c.count,
              balls: c.balls / c.count,
              strikes: c.strikes / c.count,
            },
          ],
    );
}

export function calculatePitchCalibration(
  season: number,
  sourceHash: string,
  rows: readonly PitchAnalysisRow[],
  previous: PitchCalibrationSeason | null = null,
): PitchCalibrationSeason {
  const dates = [...new Set(rows.map((r) => r.gameDate))].sort();
  const cells = preparePitchCalibrationCells(rows);
  const days = new Map<string, PitchCalibrationCell[]>();
  for (const cell of cells) {
    const group = days.get(cell.gameDate) ?? [];
    group.push(cell);
    days.set(cell.gameDate, group);
  }
  // Hash each day's aggregates once. A new game leaves earlier training windows
  // unchanged; a correction invalidates exactly the windows containing its cells.
  const dayHashes = [...days]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, group]) => [date, pitchCalibrationHash(group)] as const);
  const reuse = new Map(
    (previous?.season === season ? previous.profiles : []).map((p) => [p.asOf, p]),
  );
  const parks = universe(season);
  const profiles = dates.map((asOf): PitchCalibrationProfile => {
    const windowStart = pitchCalibrationWindowStart(asOf);
    const fingerprints = dayHashes.filter(
      ([date]) => date >= windowStart && date < asOf && date.startsWith(`${season}-`),
    );
    const inputHash = pitchCalibrationHash({
      parameters: PITCH_CALIBRATION_PARAMETERS,
      season,
      asOf,
      parks,
      fingerprints,
    });
    const known = reuse.get(asOf);
    if (known?.inputHash === inputHash) return structuredClone(known);
    return { ...fitPitchCalibration(cells, asOf, parks, "jamsil"), inputHash };
  });
  return { modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion, season, sourceHash, profiles };
}

export function pitchCalibrationLookup(calibration: PitchCalibrationSeason) {
  const values = new Map<string, Map<string, PitchCalibrationCoefficient>>();
  for (const profile of calibration.profiles) {
    if (profile.status === "ready")
      values.set(profile.asOf, new Map(profile.coefficients.map((c) => [c.parkId, c])));
  }
  return (
    row: PitchAnalysisRow,
  ): { status: PitchCalibrationStatus; coefficient: PitchCalibrationCoefficient | null } => {
    const parkId = pitchCalibrationParkId(calibration.season, row.stadium);
    if (parkId === null) return { status: "unsupported_park", coefficient: null };
    const coefficient = values.get(row.gameDate)?.get(parkId) ?? null;
    return { status: coefficient === null ? "insufficient_data" : "applied", coefficient };
  };
}

export function calibratePitchTrajectory(
  trajectory: AlignedPitchTrajectory,
  coefficient: PitchCalibrationCoefficient | null,
): AlignedPitchTrajectory {
  return coefficient === null
    ? trajectory
    : {
        ...trajectory,
        lateralAcceleration: trajectory.lateralAcceleration - coefficient.lateralBias,
        verticalAcceleration: trajectory.verticalAcceleration - coefficient.verticalBias,
      };
}

export function validPitchCalibrationSeason(value: PitchCalibrationSeason): boolean {
  const parks = universe(value.season);
  let previous = "";
  return value.profiles.every((p) => {
    if (
      p.asOf <= previous ||
      !p.asOf.startsWith(`${value.season}-`) ||
      p.windowStart !== pitchCalibrationWindowStart(p.asOf) ||
      (p.lastTrainingDate !== null &&
        (p.lastTrainingDate < p.windowStart || p.lastTrainingDate >= p.asOf))
    )
      return false;
    previous = p.asOf;
    if (p.status !== "ready") return p.coefficients.length === 0 && p.covariance.length === 0;
    return (
      p.coefficients.length === parks.length &&
      p.coefficients.every(
        (c, i) =>
          c.parkId === parks[i] &&
          c.games >= PITCH_CALIBRATION_PARAMETERS.minGames &&
          c.pitchers >= PITCH_CALIBRATION_PARAMETERS.minPitchers,
      ) &&
      p.covariance.length === parks.length * 2 &&
      p.covariance.every((row) => row.length === parks.length * 2)
    );
  });
}
