import { inAnalysisPeriod, resolveAnalysisScope } from "@kbo/contracts";
import type {
  DisciplineRow,
  DisciplineSnapshot,
  DisciplinePoint,
  DisciplineQuery,
  DisciplineResponse,
  DisciplineGroup,
} from "@kbo/contracts";
import { alignPitchTrajectory, crossingTime } from "./pitch-trajectory.js";
import { compareDisciplineCourses } from "./batter-course-comparison.js";
import { STRIKE_ZONE_HALF_WIDTH_FEET } from "./strike-zone.js";
import { observedPitchLocation } from "./pitch-location.js";

const FT_CM = 30.48;
const HALF_ZONE = STRIKE_ZONE_HALF_WIDTH_FEET;
const cuts = [-40, -20, 0, 20, 40];
export const DISCIPLINE_MIN_CONTROLS = 20;
type PreparedPoint = DisciplinePoint & { batterId: string };
export interface PreparedDisciplineSeason {
  snapshot: Omit<DisciplineSnapshot, "rows">;
  rows: readonly Pick<
    DisciplineRow,
    | "gameDate"
    | "batterId"
    | "eligible"
    | "balls"
    | "strikes"
    | "pitchType"
    | "stance"
    | "inZone"
    | "swing"
  >[];
  points: readonly PreparedPoint[];
}

const bin = (value: number, boundaries: readonly number[]): number => {
  const index = boundaries.findIndex((limit) => value < limit);
  return index < 0 ? boundaries.length : index;
};

export function disciplinePoint(
  row: DisciplineRow,
  reference: DisciplineSnapshot["reference"],
): DisciplinePoint | null {
  if (!row.eligible) return null;
  const location = observedPitchLocation(row);
  if (location === null) return null;
  const {
    xFeet: x,
    zFeet: z,
    normalizedX,
    normalizedZ,
    bottomFeet,
    topFeet,
    crossingSeconds: time,
  } = location;
  const { crossPlateY: y, y0, z0, vy0, vz0 } = row;
  let expectedXCm: number | null = null;
  let expectedZCm: number | null = null;
  let expectedInZone: boolean | null = null;
  let deltaMs: number | null = null;
  const aligned = alignPitchTrajectory(row);
  if (
    aligned !== null &&
    reference !== null &&
    row.x0 !== null &&
    row.vx0 !== null &&
    y !== null &&
    y0 !== null &&
    z0 !== null &&
    vy0 !== null &&
    vz0 !== null
  ) {
    const r = reference.trajectory;
    const expectedTime = crossingTime(y0 - y, r.vy, r.ay);
    if (expectedTime !== null) {
      // Restore this pitch's observed initial tangent. Only the aligned curvature and clock
      // come from the season reference; each trajectory is evaluated at its own plate crossing.
      const ex =
        row.x0 - (row.vx0 / vy0) * (y0 - y) + (r.lateralAcceleration * expectedTime ** 2) / 2;
      const ez = z0 - (vz0 / vy0) * (y0 - y) + (r.verticalAcceleration * expectedTime ** 2) / 2;
      if (
        [
          ex * FT_CM,
          ez * FT_CM,
          (x - ex) * FT_CM,
          (z - ez) * FT_CM,
          (time - expectedTime) * 1000,
        ].every(Number.isFinite)
      ) {
        expectedXCm = ex * FT_CM;
        expectedZCm = ez * FT_CM;
        expectedInZone = Math.abs(ex) <= HALF_ZONE && ez >= bottomFeet && ez <= topFeet;
        deltaMs = (time - expectedTime) * 1000;
      }
    }
  }
  return {
    gameId: row.gameId,
    revision: row.revision,
    pitchId: row.pitchId,
    gameDate: row.gameDate,
    pitchType: row.pitchType,
    stance: row.stance,
    speedKph: row.speedKph,
    balls: row.balls,
    strikes: row.strikes,
    swing: row.swing,
    whiff: row.whiff,
    xCm: x * FT_CM,
    zCm: z * FT_CM,
    normalizedX,
    normalizedZ,
    inZone: location.inZone,
    expectedXCm,
    expectedZCm,
    expectedInZone,
    deltaMs,
    deltaXCm: expectedXCm === null ? null : x * FT_CM - expectedXCm,
    deltaZCm: expectedZCm === null ? null : z * FT_CM - expectedZCm,
    cell: location.cell,
  };
}

export function prepareDisciplineSeason(snapshot: DisciplineSnapshot): PreparedDisciplineSeason {
  if (snapshot.rows === null) throw new Error("Discipline season requires source rows");
  return {
    snapshot: {
      season: snapshot.season,
      sourceHash: snapshot.sourceHash,
      reference: snapshot.reference,
    },
    rows: snapshot.rows.map(
      ({ gameDate, batterId, eligible, balls, strikes, pitchType, stance, inZone, swing }) => ({
        gameDate,
        batterId,
        eligible,
        balls,
        strikes,
        pitchType,
        stance,
        inZone,
        swing,
      }),
    ),
    points: snapshot.rows.flatMap((row) => {
      const point = disciplinePoint(row, snapshot.reference);
      return point === null ? [] : [{ ...point, batterId: row.batterId }];
    }),
  };
}

function matches(
  p: Pick<DisciplineRow, "balls" | "strikes" | "pitchType" | "stance">,
  q: DisciplineQuery,
) {
  return (
    (q.balls === undefined || p.balls === q.balls) &&
    (q.strikes === undefined || p.strikes === q.strikes) &&
    (q.pitchType === undefined || (p.pitchType ?? "구종 미상") === q.pitchType) &&
    (q.stance === undefined || p.stance === q.stance)
  );
}
const stratum = (p: DisciplinePoint): string =>
  JSON.stringify([
    p.balls,
    p.strikes,
    p.pitchType,
    p.stance,
    p.speedKph === null ? null : Math.floor(p.speedKph / 5),
    p.cell,
    p.inZone,
  ]);
const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function summarize(
  keys: readonly string[],
  selected: readonly PreparedPoint[],
  controls: readonly PreparedPoint[],
  groupKey: (p: DisciplinePoint) => string | null,
): DisciplineGroup[] {
  const league = new Map<string, { pitches: number; swings: number }>();
  const groupTotals = new Map<string, number>();
  for (const p of controls) {
    const group = groupKey(p);
    if (group === null) continue;
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + 1);
    const key = JSON.stringify([group, stratum(p)]);
    const entry = league.get(key) ?? { pitches: 0, swings: 0 };
    entry.pitches++;
    entry.swings += Number(p.swing);
    league.set(key, entry);
  }
  const groups = new Map(
    keys.map((key) => [
      key,
      {
        key,
        pitches: 0,
        swings: 0,
        whiffs: 0,
        matchedPitches: 0,
        matchedSwings: 0,
        expected: 0,
      },
    ]),
  );
  for (const p of selected) {
    const key = groupKey(p);
    if (key === null) continue;
    const g = groups.get(key);
    if (g === undefined) throw new Error("Unknown discipline group");
    g.pitches++;
    g.swings += Number(p.swing);
    g.whiffs += Number(p.whiff);
    const comparison = league.get(JSON.stringify([key, stratum(p)]));
    if (comparison !== undefined && comparison.pitches >= DISCIPLINE_MIN_CONTROLS) {
      g.matchedPitches++;
      g.matchedSwings += Number(p.swing);
      g.expected += comparison.swings / comparison.pitches;
    }
  }
  return [...groups.values()].map(({ expected, ...g }) => ({
    ...g,
    swingRate: rate(g.swings, g.pitches),
    whiffRate: rate(g.whiffs, g.swings),
    matchedSwingRate: rate(g.matchedSwings, g.matchedPitches),
    leaguePitches: groupTotals.get(g.key) ?? 0,
    leagueSwingRate: rate(expected, g.matchedPitches),
    difference: rate(g.matchedSwings - expected, g.matchedPitches),
  }));
}

export function analyzeBatterDiscipline(
  season: PreparedDisciplineSeason,
  batterId: string,
  query: DisciplineQuery,
): DisciplineResponse {
  if (query.season !== season.snapshot.season) throw new Error("Discipline season mismatch");
  const scope = resolveAnalysisScope({
    season: query.season,
    ...(query.competition === undefined ? {} : { competition: query.competition }),
    ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
    ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
  });
  const inTarget = (p: { gameDate: string }) => inAnalysisPeriod(p.gameDate, scope);
  const inControl = (p: { gameDate: string }) => query.leaguePeriod !== "target" || inTarget(p);
  const targetRows = season.rows.filter(
    (p) => p.batterId === batterId && matches(p, query) && inTarget(p),
  );
  const filtered = season.points.filter((p) => matches(p, query));
  const selected = filtered.filter((p) => p.batterId === batterId && inTarget(p));
  const controls = filtered.filter((p) => p.batterId !== batterId && inControl(p));
  const eligible = targetRows.filter((p) => p.eligible).length;
  const summarizeGroups = (keys: string[], key: (p: DisciplinePoint) => string | null) =>
    summarize(keys, selected, controls, key);
  const deviation = (axis: "deltaXCm" | "deltaZCm" | "deltaMs") =>
    summarizeGroups(["0", "1", "2", "3", "4", "5"], (p) => {
      const value = p[axis];
      return value === null ? null : String(bin(value, cuts));
    });
  const summaryKeys = ["zone", "outside"];
  const reference = season.snapshot.reference;
  return {
    modelVersion: 1,
    query,
    batterId,
    sourceHash: season.snapshot.sourceHash,
    baseline:
      reference === null
        ? null
        : {
            sampleCount: reference.summary.sampleCount,
            arrivalMs: reference.summary.arrivalMs,
            firstGameDate: reference.summary.firstGameDate,
            lastGameDate: reference.summary.lastGameDate,
          },
    pitchTypes: [
      ...new Set(
        season.rows.filter((p) => p.batterId === batterId).map((p) => p.pitchType ?? "구종 미상"),
      ),
    ].sort(),
    coverage: {
      actualPitches: targetRows.length,
      excludedSituations: targetRows.length - eligible,
      missingLocation: eligible - selected.length,
      locationPitches: selected.length,
      comparisonPitches: selected.filter((p) => p.expectedInZone !== null).length,
      leagueLocationPitches: controls.length,
    },
    summary: summarizeGroups(summaryKeys, (p) => (p.inZone ? "zone" : "outside")),
    courseComparison: compareDisciplineCourses(
      targetRows,
      season.rows.filter((p) => p.batterId !== batterId && matches(p, query) && inControl(p)),
      selected,
      controls,
      stratum,
      DISCIPLINE_MIN_CONTROLS,
    ),
    cells: summarizeGroups(
      Array.from({ length: 25 }, (_, i) => String(i)),
      (p) => String(p.cell),
    ),
    transitions: summarizeGroups(["in-in", "in-out", "out-in", "out-out"], (p) =>
      p.expectedInZone === null
        ? null
        : `${p.expectedInZone ? "in" : "out"}-${p.inZone ? "in" : "out"}`,
    ),
    deviations: {
      x: deviation("deltaXCm"),
      z: deviation("deltaZCm"),
      timing: deviation("deltaMs"),
    },
    points: selected.map(({ batterId: owner, ...p }) => {
      void owner;
      return p;
    }),
  };
}
