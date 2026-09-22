import {
  PITCH_CALIBRATION_PARAMETERS,
  type AnalysisScope,
  type PitchAnglesResponse,
} from "@kbo/contracts";
import { pitchApproachAngles, type PitchTrajectoryInput } from "./pitch-trajectory.js";
export type PitchAngleInput = PitchTrajectoryInput & {
  gameId: string;
  revision: number;
  pitchId: string;
  gameDate: string;
  pitcherId: string;
  stadium: string | null;
  pitchType: string | null;
  trackingId: string | null;
  supported: boolean;
};
type Point = PitchAnglesResponse["points"][number];
function summarize(points: readonly Point[]): PitchAnglesResponse["groups"] {
  const groups = new Map<
    string | null,
    { n: number; v: number; h: number; v2: number; h2: number; z: number; x: number }
  >();
  for (const p of points) {
    const g = groups.get(p.pitchType) ?? { n: 0, v: 0, h: 0, v2: 0, h2: 0, z: 0, x: 0 };
    g.n++;
    const dv = p.vaaDegrees - g.v,
      dh = p.haaDegrees - g.h;
    g.v += dv / g.n;
    g.h += dh / g.n;
    g.v2 += dv * (p.vaaDegrees - g.v);
    g.h2 += dh * (p.haaDegrees - g.h);
    g.z += (p.heightCm - g.z) / g.n;
    g.x += (p.sideCm - g.x) / g.n;
    groups.set(p.pitchType, g);
  }
  return [...groups]
    .sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0))
    .map(([pitchType, g]) => ({
      pitchType,
      pitches: g.n,
      vaaDegrees: g.v,
      haaDegrees: g.h,
      sdVaaDegrees: g.n < 2 ? null : Math.sqrt(Math.max(0, g.v2) / (g.n - 1)),
      sdHaaDegrees: g.n < 2 ? null : Math.sqrt(Math.max(0, g.h2) / (g.n - 1)),
      meanHeightCm: g.z,
      meanSideCm: g.x,
    }));
}
export function analyzePitchAngles(
  rows: readonly PitchAngleInput[],
  scope: AnalysisScope,
  pitcherId: string,
  sourceHash: string,
): PitchAnglesResponse {
  const points: Point[] = [],
    coverage = { actual: 0, missingTracking: 0, unsupported: 0, invalid: 0, used: 0 },
    games = new Map<
      string,
      {
        gameId: string;
        revision: number;
        gameDate: string;
        stadium: string | null;
        points: Point[];
      }
    >();
  for (const r of [...rows].sort((a, b) =>
    a.gameId < b.gameId
      ? -1
      : a.gameId > b.gameId
        ? 1
        : a.pitchId < b.pitchId
          ? -1
          : a.pitchId > b.pitchId
            ? 1
            : 0,
  )) {
    if (
      r.pitcherId !== pitcherId ||
      (scope.dateFrom !== null && r.gameDate < scope.dateFrom) ||
      (scope.dateTo !== null && r.gameDate > scope.dateTo)
    )
      continue;
    coverage.actual++;
    if (r.trackingId === null) {
      coverage.missingTracking++;
      continue;
    }
    if (!r.supported) {
      coverage.unsupported++;
      continue;
    }
    const angles = pitchApproachAngles(r, PITCH_CALIBRATION_PARAMETERS.plateYFeet);
    if (angles === null) {
      coverage.invalid++;
      continue;
    }
    coverage.used++;
    const point = {
      gameId: r.gameId,
      revision: r.revision,
      pitchId: r.pitchId,
      gameDate: r.gameDate,
      pitchType: r.pitchType,
      ...angles,
    };
    points.push(point);
    const key = JSON.stringify([r.gameId, r.revision]),
      game = games.get(key) ?? {
        gameId: r.gameId,
        revision: r.revision,
        gameDate: r.gameDate,
        stadium: r.stadium,
        points: [],
      };
    game.points.push(point);
    games.set(key, game);
  }
  return {
    version: 1,
    policy: "raw-trajectory-middle-plane-v1",
    planeYFeet: PITCH_CALIBRATION_PARAMETERS.plateYFeet,
    scope,
    pitcherId,
    sourceHash,
    coverage,
    groups: summarize(points),
    games: [...games.values()]
      .sort((a, b) =>
        a.gameDate < b.gameDate
          ? -1
          : a.gameDate > b.gameDate
            ? 1
            : a.gameId < b.gameId
              ? -1
              : a.gameId > b.gameId
                ? 1
                : 0,
      )
      .map(({ points: gamePoints, ...game }) => ({ ...game, groups: summarize(gamePoints) })),
    points,
  };
}
