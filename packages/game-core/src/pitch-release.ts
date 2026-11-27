import type { PitchReleaseGroup } from "@kbo/contracts";
import { pitchTimeAtPlane, type PitchTrajectoryInput } from "./pitch-trajectory.js";

type Geometry = Omit<PitchTrajectoryInput, "crossPlateY">;
type MeasuredGeometry = { [K in keyof Geometry]: number };
interface ReleaseRow extends Geometry {
  readonly gameId: string;
  readonly pitchType: string | null;
  readonly trackingId: string | null;
  readonly supported: boolean;
}

const INCHES_PER_FOOT = 12;
const MIN_PLANE_INCHES = 45 * INCHES_PER_FOOT;
const RUBBER_INCHES = 60.5 * INCHES_PER_FOOT;
const FEET_TO_CM = 30.48;
const MIN_PITCHES = 120;
const MIN_GAMES = 3;

function timeAtPlane(row: MeasuredGeometry, yFeet: number): number | null {
  return pitchTimeAtPlane(row.y0, row.vy0, row.ay, yFeet);
}

export function pitchReleaseDepths(
  groups: readonly PitchReleaseGroup[],
): ReadonlyMap<string, number> {
  return new Map(
    groups.flatMap(({ pitchType, estimate }) =>
      estimate === null
        ? []
        : [[pitchType, RUBBER_INCHES / INCHES_PER_FOOT - estimate.extensionCm / FEET_TO_CM]],
    ),
  );
}

function hasGeometry(row: ReleaseRow): row is ReleaseRow & MeasuredGeometry {
  const { x0, y0, z0, vx0, vy0, vz0, ax, ay, az } = row;
  return (
    row.supported &&
    row.trackingId !== null &&
    [x0, y0, z0, vx0, vy0, vz0, ax, ay, az].every(Number.isFinite) &&
    z0 !== null &&
    z0 > 0 &&
    vy0 !== null &&
    vy0 < 0
  );
}

function fitRelease(games: readonly MeasuredGeometry[][]): PitchReleaseGroup["estimate"] {
  let bestArea = Infinity;
  let bestPlane = MIN_PLANE_INCHES;
  let bestX = 0;
  let bestZ = 0;
  let count = 0;
  for (let plane = MIN_PLANE_INCHES; plane <= RUBBER_INCHES; plane++) {
    const yFeet = plane / INCHES_PER_FOOT;
    let xSum = 0;
    let zSum = 0;
    let xx = 0;
    let zz = 0;
    let xz = 0;
    let pitches = 0;
    for (const game of games) {
      let xMean = 0;
      let zMean = 0;
      let n = 0;
      for (const row of game) {
        const t = timeAtPlane(row, yFeet);
        if (t === null) return null;
        const x = row.x0 + row.vx0 * t + (row.ax * t * t) / 2;
        const z = row.z0 + row.vz0 * t + (row.az * t * t) / 2;
        // Pool within-game scatter so movement between starts cannot drive the minimum.
        n++;
        const dx = x - xMean;
        const dz = z - zMean;
        xMean += dx / n;
        zMean += dz / n;
        xx += dx * (x - xMean);
        zz += dz * (z - zMean);
        xz += dx * (z - zMean);
        xSum += x;
        zSum += z;
      }
      pitches += n;
    }
    // The covariance denominator is constant across planes for the same set of pitches.
    const area = xx * zz - xz * xz;
    if (area >= 0 && area < bestArea) {
      bestArea = area;
      bestPlane = plane;
      bestX = xSum;
      bestZ = zSum;
      count = pitches;
    }
  }
  if (bestPlane === MIN_PLANE_INCHES || bestPlane === RUBBER_INCHES || bestArea <= 0 || bestZ <= 0)
    return null;
  const estimate = {
    xCm: (bestX / count) * FEET_TO_CM,
    heightCm: (bestZ / count) * FEET_TO_CM,
    extensionCm: ((RUBBER_INCHES - bestPlane) / INCHES_PER_FOOT) * FEET_TO_CM,
  };
  return Object.values(estimate).every(Number.isFinite) ? estimate : null;
}

export function estimatePitchReleases(rows: readonly ReleaseRow[]): PitchReleaseGroup[] {
  const types = new Map<string, Map<string, MeasuredGeometry[]>>();
  for (const row of rows) {
    if (
      !row.pitchType ||
      !hasGeometry(row) ||
      timeAtPlane(row, MIN_PLANE_INCHES / INCHES_PER_FOOT) === null ||
      timeAtPlane(row, RUBBER_INCHES / INCHES_PER_FOOT) === null
    )
      continue;
    let games = types.get(row.pitchType);
    if (games === undefined) {
      games = new Map();
      types.set(row.pitchType, games);
    }
    const game = games.get(row.gameId);
    if (game === undefined) games.set(row.gameId, [row]);
    else game.push(row);
  }
  return Array.from(types, ([pitchType, games]) => {
    const usable = [...games.values()].filter((game) => game.length >= 2);
    const pitches = usable.reduce((sum, game) => sum + game.length, 0);
    return {
      pitchType,
      pitches,
      games: usable.length,
      estimate: pitches < MIN_PITCHES || usable.length < MIN_GAMES ? null : fitRelease(usable),
    };
  })
    .filter((group) => group.pitches > 0)
    .sort(
      (a, b) =>
        b.pitches - a.pitches ||
        (a.pitchType < b.pitchType ? -1 : a.pitchType === b.pitchType ? 0 : 1),
    );
}
