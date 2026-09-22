import {
  PITCH_CALIBRATION_PARAMETERS as parameters,
  type PitchCalibrationProfile,
} from "@kbo/contracts";
import { multiply, symmetricInverse } from "./pitch-calibration-matrix.js";

export interface PitchCalibrationCell {
  readonly gameId: string;
  readonly gameDate: string;
  readonly parkId: string;
  readonly pitcherId: string;
  readonly pitchType: string;
  readonly count: number;
  readonly lateral: number;
  readonly vertical: number;
  readonly speed: number;
  readonly left: number;
  readonly balls: number;
  readonly strikes: number;
}

type Fit = Omit<PitchCalibrationProfile, "inputHash">;
type Observation = {
  cell: PitchCalibrationCell;
  group: string;
  x: number[];
  y: number[];
  w: number;
};
const dayMs = 86_400_000;
const day = (value: string): number => Date.parse(`${value}T00:00:00Z`) / dayMs;

export function pitchCalibrationWindowStart(asOf: string): string {
  return new Date((day(asOf) - parameters.windowDays) * dayMs).toISOString().slice(0, 10);
}

/** Same pitcher/type/month, speed, stance and count controls as the offline study. */
export function fitPitchCalibration(
  cells: readonly PitchCalibrationCell[],
  asOf: string,
  parkUniverse: readonly string[],
  anchorPark: string,
): Fit {
  const parks = [...new Set(parkUniverse)].sort();
  const allowed = new Set(parks);
  const windowStart = pitchCalibrationWindowStart(asOf);
  const input = cells
    .filter(
      (c) =>
        c.gameDate >= windowStart &&
        c.gameDate < asOf &&
        c.gameDate.slice(0, 4) === asOf.slice(0, 4) &&
        allowed.has(c.parkId) &&
        c.count >= parameters.minCellPitches,
    )
    // Preserve the original serialized-key order without rebuilding keys at
    // every sort comparison in every daily fitting window.
    .map((cell) => ({
      cell,
      key: JSON.stringify([
        cell.gameDate,
        cell.gameId,
        cell.pitcherId,
        cell.pitchType,
        cell.parkId,
      ]),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ cell }) => cell);
  const groupKeys = new Map(
    input.map((c) => [c, JSON.stringify([c.pitcherId, c.pitchType, c.gameDate.slice(0, 7)])]),
  );
  const groupKey = (c: PitchCalibrationCell) => {
    const key = groupKeys.get(c);
    if (key === undefined) throw new Error("Missing calibration group key");
    return key;
  };
  const groups = new Map<string, Set<string>>();
  for (const cell of input) {
    const key = groupKey(cell);
    const group = groups.get(key) ?? new Set<string>();
    group.add(cell.parkId);
    groups.set(key, group);
  }
  // A contrast is only meaningful inside one connected cross-park comparison network.
  const connected = new Set([anchorPark]);
  for (let i = 0; i < parks.length; i++) {
    const before = connected.size;
    for (const group of groups.values()) {
      if ([...group].some((p) => connected.has(p))) for (const p of group) connected.add(p);
    }
    if (connected.size === before) break;
  }
  const frame = input.filter(
    (c) => (groups.get(groupKey(c))?.size ?? 0) >= 2 && connected.has(c.parkId),
  );
  const base: Fit = {
    asOf,
    windowStart,
    status: "insufficient_data",
    lastTrainingDate: frame.at(-1)?.gameDate ?? null,
    trainingCells: frame.length,
    trainingGames: new Set(frame.map((c) => c.gameId)).size,
    trainingPitchers: new Set(frame.map((c) => c.pitcherId)).size,
    coefficients: [],
    covariance: [],
  };
  const counts = parks.map((parkId) => {
    const selected = frame.filter((c) => c.parkId === parkId);
    return {
      parkId,
      games: new Set(selected.map((c) => c.gameId)).size,
      pitchers: new Set(selected.map((c) => c.pitcherId)).size,
      pitches: selected.reduce((sum, c) => sum + c.count, 0),
      cells: selected.length,
    };
  });
  // A fixed park universe keeps the zero point stable across days. Unknown parks
  // never contribute assumed zero biases to a partly identified center.
  if (
    frame.length < 100 ||
    parks.length < 3 ||
    !allowed.has(anchorPark) ||
    counts.some((c) => c.games < parameters.minGames || c.pitchers < parameters.minPitchers)
  )
    return base;
  const types = [...new Set(frame.map((c) => c.pitchType))].sort();
  const columns = parks.length - 1 + 2 * types.length + 3;
  const asOfDay = day(asOf);
  const observations: Observation[] = frame.map((cell) => {
    const speed = (cell.speed - 140) / 10;
    const x = parks.slice(0, -1).map((p) => Number(cell.parkId === p));
    for (const type of types) {
      const matches = Number(cell.pitchType === type);
      x.push(matches * speed, matches * speed * speed);
    }
    x.push(cell.left, cell.balls, cell.strikes);
    return {
      cell,
      group: groupKey(cell),
      x,
      y: [cell.lateral, cell.vertical],
      w:
        Math.min(cell.count, parameters.maxCellWeight) *
        2 ** (-(asOfDay - day(cell.gameDate)) / parameters.halfLifeDays),
    };
  });
  const centered = demean(observations, columns);
  const normal = Array.from({ length: columns }, () => Array<number>(columns).fill(0));
  const rhs = Array.from({ length: columns }, () => [0, 0]);
  for (const { x, y, w } of centered) {
    for (let i = 0; i < columns; i++) {
      const n = normal[i];
      const r = rhs[i];
      if (n === undefined || r === undefined) throw new Error("Invalid calibration design");
      const wx = w * (x[i] ?? 0);
      for (let j = 0; j < columns; j++) n[j] = (n[j] ?? 0) + wx * (x[j] ?? 0);
      r[0] = (r[0] ?? 0) + wx * (y[0] ?? 0);
      r[1] = (r[1] ?? 0) + wx * (y[1] ?? 0);
    }
  }
  const decomposition = symmetricInverse(normal);
  const transform = parks.map((_, i) =>
    Array.from({ length: columns }, (_, j) =>
      j < parks.length - 1 ? Number(i === j) - 1 / parks.length : 0,
    ),
  );
  const identified = multiply(transform, decomposition.projection);
  if (
    !decomposition.converged ||
    transform.some((row, i) => row.some((v, j) => Math.abs(v - (identified[i]?.[j] ?? 0)) > 1e-7))
  )
    return { ...base, status: "unidentifiable" };
  const beta = multiply(decomposition.inverse, rhs);
  const offsets = multiply(transform, beta);
  const covariance = clusterCovariance(
    centered,
    beta,
    multiply(transform, decomposition.inverse),
    new Set(frame.map(groupKey)).size + decomposition.rank,
  );
  const coefficients = counts.map((count, i) => ({
    ...count,
    lateralBias: offsets[i]?.[0] ?? 0,
    verticalBias: offsets[i]?.[1] ?? 0,
    lateralStandardError: Math.sqrt(Math.max(0, covariance[2 * i]?.[2 * i] ?? 0)),
    verticalStandardError: Math.sqrt(Math.max(0, covariance[2 * i + 1]?.[2 * i + 1] ?? 0)),
  }));
  if (
    coefficients.some(
      (c) =>
        ![c.lateralBias, c.verticalBias, c.lateralStandardError, c.verticalStandardError].every(
          Number.isFinite,
        ),
    ) ||
    covariance.some((row) => !row.every(Number.isFinite))
  )
    return { ...base, status: "unidentifiable" };
  return { ...base, status: "ready", coefficients, covariance };
}

function demean(rows: readonly Observation[], columns: number): Observation[] {
  const means = new Map<string, { x: number[]; y: number[]; w: number }>();
  for (const { group, x, y, w } of rows) {
    const mean = means.get(group) ?? { x: Array<number>(columns).fill(0), y: [0, 0], w: 0 };
    mean.w += w;
    for (let i = 0; i < columns; i++) mean.x[i] = (mean.x[i] ?? 0) + w * (x[i] ?? 0);
    for (let i = 0; i < 2; i++) mean.y[i] = (mean.y[i] ?? 0) + w * (y[i] ?? 0);
    means.set(group, mean);
  }
  return rows.map((row) => {
    const mean = means.get(row.group);
    if (mean === undefined || !(mean.w > 0)) throw new Error("Invalid calibration group");
    return {
      ...row,
      x: row.x.map((v, i) => v - (mean.x[i] ?? 0) / mean.w),
      y: row.y.map((v, i) => v - (mean.y[i] ?? 0) / mean.w),
    };
  });
}

function clusterCovariance(
  rows: readonly Observation[],
  beta: readonly number[][],
  influenceTransform: readonly number[][],
  parameterCount: number,
): number[][] {
  const dimension = influenceTransform.length * 2;
  const covariance = Array.from({ length: dimension }, () => Array<number>(dimension).fill(0));
  const clusterings = [
    { key: (c: PitchCalibrationCell) => c.pitcherId, sign: 1 },
    { key: (c: PitchCalibrationCell) => c.gameId, sign: 1 },
    { key: (c: PitchCalibrationCell) => JSON.stringify([c.pitcherId, c.gameId]), sign: -1 },
  ];
  const scores = rows.map(({ cell, x, y, w }) => {
    const predicted = multiply([x], beta)[0] ?? [0, 0];
    const residual = y.map((v, i) => v - (predicted[i] ?? 0));
    const score = influenceTransform.flatMap((t) => {
      const value = t.reduce((sum, v, j) => sum + v * (x[j] ?? 0), 0) * w;
      return residual.map((r) => value * r);
    });
    return { cell, score };
  });
  for (const { key, sign } of clusterings) {
    const clusters = new Map<string, number[]>();
    for (const { cell, score } of scores) {
      const id = key(cell);
      const sum = clusters.get(id) ?? Array<number>(dimension).fill(0);
      for (let i = 0; i < dimension; i++) sum[i] = (sum[i] ?? 0) + (score[i] ?? 0);
      clusters.set(id, sum);
    }
    const factor =
      sign *
      (clusters.size / (clusters.size - 1)) *
      ((rows.length - 1) / Math.max(1, rows.length - parameterCount));
    for (const score of clusters.values()) {
      for (let i = 0; i < dimension; i++) {
        const row = covariance[i];
        if (row === undefined) throw new Error("Invalid calibration covariance");
        for (let j = 0; j < dimension; j++)
          row[j] = (row[j] ?? 0) + factor * (score[i] ?? 0) * (score[j] ?? 0);
      }
    }
  }
  // Finite-sample two-way cluster covariances can be indefinite; retain the
  // nonnegative eigenspace without manufacturing an identifiable global offset.
  const eigen = symmetricInverse(covariance);
  if (!eigen.converged) return covariance;
  return covariance.map((_, i) =>
    Array.from({ length: dimension }, (__, j) =>
      eigen.values.reduce(
        (sum, v, k) =>
          sum + Math.max(0, v) * (eigen.vectors[i]?.[k] ?? 0) * (eigen.vectors[j]?.[k] ?? 0),
        0,
      ),
    ),
  );
}
