import type {
  PitchSequenceRow,
  PitchSequenceQuery,
  PitchSequenceResponse,
  AnalysisScope,
} from "@kbo/contracts";
import { crossingTime } from "./pitch-trajectory.js";
import { matchesPitchOutcome } from "./pitch-outcomes.js";
/** Provider coordinates, with no endpoint bias correction extended to the middle of the trajectory. */
export function pitchPositionAtPlane(row: PitchSequenceRow, y: number) {
  const { x0, y0, z0, vx0, vy0, vz0, ax, ay, az } = row;
  if (
    !row.supported ||
    row.trackingId === null ||
    x0 === null ||
    y0 === null ||
    z0 === null ||
    vx0 === null ||
    vy0 === null ||
    vz0 === null ||
    ax === null ||
    ay === null ||
    az === null ||
    ![x0, y0, z0, vx0, vy0, vz0, ax, ay, az, y].every(Number.isFinite) ||
    Math.abs(y0 - 50) > 1e-6 ||
    y < 0 ||
    y >= y0
  )
    return null;
  const t = crossingTime(y0 - y, vy0, ay);
  if (t === null) return null;
  const x = x0 + vx0 * t + (ax * t * t) / 2,
    z = z0 + vz0 * t + (az * t * t) / 2;
  if (![x, z].every(Number.isFinite) || z < 0) return null;
  return { xCm: x * 30.48, zCm: z * 30.48, timeMs: t * 1000 };
}
export function analyzePitchSequences(
  query: PitchSequenceQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  input: readonly PitchSequenceRow[],
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
    const ap =
        previous.crossPlateY === null ? null : pitchPositionAtPlane(previous, previous.crossPlateY),
      bp = current.crossPlateY === null ? null : pitchPositionAtPlane(current, current.crossPlateY);
    pairs.push({
      previous,
      current,
      planeDistanceCm: a === null || b === null ? null : Math.hypot(a.xCm - b.xCm, a.zCm - b.zCm),
      planeTimeDifferenceMs: a === null || b === null ? null : b.timeMs - a.timeMs,
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
    coverage,
    pairs,
    groups: [...groups]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, values]) => {
        const avg = (f: (r: (typeof pairs)[number]) => number | null) => {
          const v = values.flatMap((r) => {
            const n = f(r);
            return n === null ? [] : [n];
          });
          return divide(
            v.reduce((a, b) => a + b, 0),
            v.length,
          );
        };
        const swings = values.filter((p) => p.current.swing).length,
          whiffs = values.filter((p) => p.current.whiff).length,
          calledStrikes = values.filter((p) => p.current.calledStrike).length;
        return {
          key,
          pairs: values.length,
          swings,
          whiffs,
          calledStrikes,
          swingRate: divide(swings, values.length),
          whiffRate: divide(whiffs, swings),
          calledStrikeRate: divide(calledStrikes, values.length),
          geometryPairs: values.filter((p) => p.planeDistanceCm !== null).length,
          meanPlaneDistanceCm: avg((p) => p.planeDistanceCm),
          meanPlaneTimeDifferenceMs: avg((p) => p.planeTimeDifferenceMs),
          meanSpeedDifferenceKph: avg((p) => p.speedDifferenceKph),
          meanArrivalDistanceCm: avg((p) => p.arrivalDistanceCm),
        };
      }),
  };
}
