import { createHash } from "node:crypto";
import {
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  type PitchQualityRow,
  type PitchQualityPreprocessing,
  type PitchQualityCoverage,
} from "@kbo/contracts";
import {
  alignPitchTrajectory,
  averagePitchTrajectory,
  comparePitchTrajectory,
  type AlignedPitchTrajectory,
} from "./pitch-trajectory.js";
import { observedPitchLocation } from "./pitch-location.js";
import type { BinaryDesign } from "./binary-logit.js";
export const qualityHash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
export type QualityPrepared = Pick<
  PitchQualityRow,
  | "gameId"
  | "revision"
  | "pitchId"
  | "gameDate"
  | "season"
  | "pitcherId"
  | "batterId"
  | "parkId"
  | "pitchType"
  | "stance"
  | "balls"
  | "strikes"
  | "swing"
  | "whiff"
  | "calledStrike"
  | "eligible"
  | "speedKph"
> & { trajectory: AlignedPitchTrajectory | null; location: { x: number; z: number } | null };
export type QualitySample = { row: QualityPrepared; key: string; features: number[] };
export function prepareQualityRows(
  rows: readonly PitchQualityRow[],
  geometry = true,
): QualityPrepared[] {
  return rows.map((r) => {
    const location = geometry ? observedPitchLocation(r) : null;
    return {
      gameId: r.gameId,
      revision: r.revision,
      pitchId: r.pitchId,
      gameDate: r.gameDate,
      season: r.season,
      pitcherId: r.pitcherId,
      batterId: r.batterId,
      parkId: r.parkId,
      pitchType: r.pitchType,
      stance: r.stance,
      balls: r.balls,
      strikes: r.strikes,
      swing: r.swing,
      whiff: r.whiff,
      calledStrike: r.calledStrike,
      eligible: r.eligible,
      speedKph: r.speedKph,
      trajectory:
        geometry && r.supported && r.trackingId !== null
          ? alignPitchTrajectory({ ...r, crossPlateY: PITCH_CALIBRATION_PARAMETERS.plateYFeet })
          : null,
      location: location === null ? null : { x: location.normalizedX, z: location.normalizedZ },
    };
  });
}
function calibration(pre: PitchQualityPreprocessing) {
  return new Map(
    pre.profiles.map((p) => [
      p.season,
      new Map(p.profile.status === "ready" ? p.profile.coefficients.map((c) => [c.parkId, c]) : []),
    ]),
  );
}
function corrected(
  row: QualityPrepared,
  pre: PitchQualityPreprocessing,
  lookup: ReturnType<typeof calibration>,
) {
  const coefficient =
    row.parkId === null
      ? undefined
      : lookup.get(Math.min(row.season, pre.through))?.get(row.parkId);
  return coefficient === undefined || row.trajectory === null
    ? null
    : {
        ...row.trajectory,
        lateralAcceleration: row.trajectory.lateralAcceleration - coefficient.lateralBias,
        verticalAcceleration: row.trajectory.verticalAcceleration - coefficient.verticalBias,
      };
}
function numeric(
  row: QualityPrepared,
  trajectory: AlignedPitchTrajectory,
  pre: PitchQualityPreprocessing,
): number[] | null {
  if (
    pre.reference === null ||
    row.location === null ||
    row.speedKph === null ||
    row.speedKph <= 0 ||
    row.speedKph >= 500
  )
    return null;
  const shape = comparePitchTrajectory(trajectory, pre.reference);
  if (shape === null) return null;
  const { x, z } = row.location;
  const values = [
    row.speedKph,
    shape.xCm,
    shape.zCm,
    shape.timingDifferenceMs,
    x,
    z,
    x * x,
    z * z,
    x * z,
  ];
  return values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e6) ? values : null;
}
export function qualityCohort(
  rows: readonly QualityPrepared[],
  pre: PitchQualityPreprocessing,
  enforceSupport = true,
) {
  const coverage: PitchQualityCoverage = {
      actual: rows.length,
      ineligible: 0,
      missing: 0,
      calibrationUnsupported: 0,
      outOfSupport: 0,
      modelUnavailable: 0,
      used: 0,
    },
    samples: QualitySample[] = [],
    lookup = calibration(pre);
  for (const row of rows) {
    if (!row.eligible) {
      coverage.ineligible++;
      continue;
    }
    if (
      row.pitchType === null ||
      row.stance === null ||
      row.trajectory === null ||
      row.location === null ||
      row.speedKph === null ||
      row.speedKph <= 0 ||
      row.speedKph >= 500
    ) {
      coverage.missing++;
      continue;
    }
    const trajectory = corrected(row, pre, lookup);
    if (trajectory === null || pre.reference === null) {
      coverage.calibrationUnsupported++;
      continue;
    }
    const features = numeric(row, trajectory, pre);
    if (features === null) {
      coverage.missing++;
      continue;
    }
    if (
      enforceSupport &&
      (!pre.pitchTypes.includes(row.pitchType) ||
        !pre.stances.includes(row.stance) ||
        features.some(
          (v, i) =>
            !Number.isFinite(v) ||
            v < (pre.minima[i] ?? Infinity) - 1e-9 ||
            v > (pre.maxima[i] ?? -Infinity) + 1e-9,
        ))
    ) {
      coverage.outOfSupport++;
      continue;
    }
    coverage.used++;
    samples.push({
      row,
      features,
      key: canonicalStringify([row.pitchType, row.balls, row.strikes, row.stance]),
    });
  }
  return { coverage, samples };
}
export function fitQualityPreprocessing(
  rows: readonly QualityPrepared[],
  profiles: PitchQualityPreprocessing["profiles"],
  through: number,
): PitchQualityPreprocessing {
  const training = rows.filter((r) => r.season <= through),
    pre: PitchQualityPreprocessing = {
      through,
      policy: "frozen-training-season-middle-plane-v1",
      profiles: profiles.filter((p) => p.season >= 2020 && p.season <= through),
      reference: null,
      referenceHash: qualityHash(null),
      pitchTypes: [],
      stances: [],
      means: [],
      scales: [],
      minima: [],
      maxima: [],
    },
    lookup = calibration(pre);
  const fastballs: AlignedPitchTrajectory[] = [];
  for (const r of training)
    if (r.eligible && r.pitchType === "직구") {
      const value = corrected(r, pre, lookup);
      if (value !== null) fastballs.push(value);
    }
  pre.reference = averagePitchTrajectory(fastballs);
  pre.referenceHash = qualityHash(pre.reference);
  const cohort = qualityCohort(training, pre, false).samples;
  pre.pitchTypes = [
    ...new Set(cohort.flatMap((s) => (s.row.pitchType === null ? [] : [s.row.pitchType]))),
  ].sort();
  pre.stances = [
    ...new Set(cohort.flatMap((s) => (s.row.stance === null ? [] : [s.row.stance]))),
  ].sort();
  for (let i = 0; i < 9; i++) {
    let mean = 0,
      m2 = 0,
      min = Infinity,
      max = -Infinity,
      n = 0;
    for (const s of cohort) {
      const v = s.features[i] ?? 0;
      n++;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    pre.means.push(mean);
    pre.scales.push(n === 0 ? 1 : Math.max(Math.sqrt(m2 / n), 1e-8));
    pre.minima.push(n === 0 ? 0 : min);
    pre.maxima.push(n === 0 ? 0 : max);
  }
  return pre;
}
export function qualityDesign(
  samples: readonly QualitySample[],
  pre: PitchQualityPreprocessing,
  kind: "shape" | "location",
): BinaryDesign {
  const numericCount = kind === "shape" ? 4 : 9,
    width = 1 + pre.pitchTypes.length + pre.stances.length + 12 + numericCount,
    values = new Float64Array(samples.length * width),
    types = new Map(pre.pitchTypes.map((v, i) => [v, i])),
    stances = new Map(pre.stances.map((v, i) => [v, i]));
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s === undefined) continue;
    const start = i * width,
      type = types.get(s.row.pitchType ?? ""),
      stance = stances.get(s.row.stance ?? "");
    values[start] = 1;
    if (type !== undefined) values[start + 1 + type] = 1;
    if (stance !== undefined) values[start + 1 + pre.pitchTypes.length + stance] = 1;
    const countStart = start + 1 + pre.pitchTypes.length + pre.stances.length;
    values[countStart + s.row.balls * 3 + s.row.strikes] = 1;
    for (let j = 0; j < numericCount; j++)
      values[countStart + 12 + j] =
        ((s.features[j] ?? 0) - (pre.means[j] ?? 0)) / (pre.scales[j] ?? 1);
  }
  return { values, width };
}
