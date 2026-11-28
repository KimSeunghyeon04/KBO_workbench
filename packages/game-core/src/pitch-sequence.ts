import type {
  PitchSequenceRow,
  PitchSequenceQuery,
  PitchSequenceResponse,
  AnalysisScope,
  PitchReleaseGroup,
} from "@kbo/contracts";
import {
  pitchComparisonStart,
  pitchStateAtPlane,
  PITCH_COMPARISON_START_FEET,
} from "./pitch-trajectory.js";
import { matchesPitchOutcome } from "./pitch-outcomes.js";
/** Provider coordinates, with no endpoint bias correction extended to the middle of the trajectory. */
export function pitchPositionAtPlane(row: PitchSequenceRow, y: number) {
  if (!row.supported || row.trackingId === null) return null;
  const point = pitchStateAtPlane(row, y);
  if (point === null) return null;
  const start = y <= PITCH_COMPARISON_START_FEET ? pitchComparisonStart(row) : null;
  return {
    xCm: point.x * 30.48,
    zCm: point.z * 30.48,
    timeMs: start === null ? null : (point.seconds - start.seconds) * 1000,
  };
}
export function analyzePitchSequences(
  query: PitchSequenceQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  input: readonly PitchSequenceRow[],
  releaseGroups: readonly PitchReleaseGroup[] = [],
): PitchSequenceResponse {
  const rows = [...input].sort((a, b) =>
    a.gameId === b.gameId
      ? a.revision === b.revision
        ? a.pitchSequence - b.pitchSequence
        : a.revision - b.revision
      : a.gameId < b.gameId
        ? -1
        : 1,
  );
  const pairs: PitchSequenceResponse["pairs"] = [],
    coverage = {
      targetPitches: 0,
      noPrevious: 0,
      nonActualBoundary: 0,
      playerChange: 0,
      eligiblePairs: 0,
      filteredPairs: 0,
      geometryPairs: 0,
    };
  for (let i = 0; i < rows.length; i++) {
    const current = rows[i];
    if (current === undefined || !current.actual || current.pitcherId !== pitcherId) continue;
    coverage.targetPitches++;
    const previous = rows[i - 1];
    if (
      previous === undefined ||
      previous.gameId !== current.gameId ||
      previous.revision !== current.revision ||
      current.paId === null ||
      previous.paId !== current.paId
    ) {
      coverage.noPrevious++;
      continue;
    }
    if (!previous.actual) {
      coverage.nonActualBoundary++;
      continue;
    }
    if (
      previous.pitcherId !== current.pitcherId ||
      previous.batterId !== current.batterId ||
      current.batterId === null ||
      current.interveningChange
    ) {
      coverage.playerChange++;
      continue;
    }
    coverage.eligiblePairs++;
    if (
      !matchesPitchOutcome(current, query) ||
      (query.previousType !== undefined && query.previousType !== previous.pitchType) ||
      (query.cohort === "discipline" && !current.eligible)
    )
      continue;
    const a = pitchPositionAtPlane(previous, 23.8),
      b = pitchPositionAtPlane(current, 23.8);
    const aTime = a?.timeMs ?? null,
      bTime = b?.timeMs ?? null;
    const ap =
        previous.crossPlateY === null ? null : pitchPositionAtPlane(previous, previous.crossPlateY),
      bp = current.crossPlateY === null ? null : pitchPositionAtPlane(current, current.crossPlateY);
    pairs.push({
      previous,
      current,
      planeDistanceCm: a === null || b === null ? null : Math.hypot(a.xCm - b.xCm, a.zCm - b.zCm),
      planeTimeDifferenceMs: aTime === null || bTime === null ? null : bTime - aTime,
      speedDifferenceKph:
        previous.speedKph === null || current.speedKph === null
          ? null
          : current.speedKph - previous.speedKph,
      arrivalDistanceCm:
        ap === null || bp === null || previous.crossPlateX === null || current.crossPlateX === null
          ? null
          : Math.hypot((current.crossPlateX - previous.crossPlateX) * 30.48, bp.zCm - ap.zCm),
    });
  }
  coverage.filteredPairs = pairs.length;
  coverage.geometryPairs = pairs.filter((p) => p.planeDistanceCm !== null).length;
  const groups = new Map<string, typeof pairs>();
  for (const pair of pairs) {
    const key = JSON.stringify([pair.previous.pitchType, pair.current.pitchType]),
      group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }
  const divide = (a: number, b: number) => (b === 0 ? null : a / b);
  return {
    query,
    pitcherId,
    scope,
    sourceHash,
    planeYFeet: 23.8,
    releaseGroups: [...releaseGroups],
    coverage,
    pairs,
    groups: [...groups]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, values]) => {
        const avg = (f: (r: (typeof pairs)[number]) => number | null) => {
          let sum = 0,
            count = 0;
          for (const row of values) {
            const value = f(row);
            if (value === null) continue;
            sum += value;
            count++;
          }
          return { mean: divide(sum, count), count };
        };
        const swings = values.filter((p) => p.current.swing).length,
          whiffs = values.filter((p) => p.current.whiff).length,
          calledStrikes = values.filter((p) => p.current.calledStrike).length,
          planeDistance = avg((p) => p.planeDistanceCm),
          planeTimeDifference = avg((p) => p.planeTimeDifferenceMs),
          speedDifference = avg((p) => p.speedDifferenceKph),
          arrivalDistance = avg((p) => p.arrivalDistanceCm);
        return {
          key,
          pairs: values.length,
          swings,
          whiffs,
          calledStrikes,
          swingRate: divide(swings, values.length),
          whiffRate: divide(whiffs, swings),
          calledStrikeRate: divide(calledStrikes, values.length),
          geometryPairs: planeDistance.count,
          planeDistancePairs: planeDistance.count,
          planeTimeDifferencePairs: planeTimeDifference.count,
          speedDifferencePairs: speedDifference.count,
          arrivalDistancePairs: arrivalDistance.count,
          meanPlaneDistanceCm: planeDistance.mean,
          meanPlaneTimeDifferenceMs: planeTimeDifference.mean,
          meanSpeedDifferenceKph: speedDifference.mean,
          meanArrivalDistanceCm: arrivalDistance.mean,
        };
      }),
  };
}
