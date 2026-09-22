import type {
  DisciplineCourseComparison,
  DisciplineCourseRates,
  DisciplinePoint,
  DisciplineRow,
} from "@kbo/contracts";

type CourseRow = Pick<DisciplineRow, "eligible" | "inZone" | "swing">;
const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function courseRates(rows: readonly Pick<CourseRow, "inZone" | "swing">[]): DisciplineCourseRates {
  let zonePitches = 0;
  let zoneSwings = 0;
  let outsidePitches = 0;
  let outsideSwings = 0;
  for (const p of rows) {
    if (p.inZone === null) continue;
    if (p.inZone) {
      zonePitches++;
      zoneSwings += Number(p.swing);
    } else {
      outsidePitches++;
      outsideSwings += Number(p.swing);
    }
  }
  const pitches = zonePitches + outsidePitches;
  const swings = zoneSwings + outsideSwings;
  return {
    pitches,
    swings,
    zonePitches,
    zoneSwings,
    outsidePitches,
    outsideSwings,
    zoneRate: rate(zonePitches, pitches),
    swingRate: rate(swings, pitches),
    chaseRate: rate(outsideSwings, outsidePitches),
    zoneSwingRate: rate(zoneSwings, zonePitches),
  };
}

export function compareDisciplineCourses(
  targetRows: readonly CourseRow[],
  controlRows: readonly CourseRow[],
  selected: readonly DisciplinePoint[],
  controls: readonly DisciplinePoint[],
  stratum: (p: DisciplinePoint) => string,
  minControls: number,
): DisciplineCourseComparison {
  const target = selected.filter((p) => p.expectedInZone !== null);
  const league = controls.filter((p) => p.expectedInZone !== null);
  type Tally = { pitches: number; swings: number };
  const course = new Map<string, Tally>();
  const expectation = new Map<string, Tally>();
  const add = (map: Map<string, Tally>, key: string, p: DisciplinePoint) => {
    const count = map.get(key) ?? { pitches: 0, swings: 0 };
    count.pitches++;
    count.swings += Number(p.swing);
    map.set(key, count);
  };
  for (const p of league) {
    if (p.inZone) continue;
    const key = stratum(p);
    add(course, key, p);
    add(expectation, JSON.stringify([key, p.expectedInZone]), p);
  }
  const keys = ["outside", "in-out", "out-out"] as const;
  const tallies = keys.map((key) => ({
    key,
    pitches: 0,
    swings: 0,
    matchedPitches: 0,
    matchedSwings: 0,
    courseExpected: 0,
    expectationExpected: 0,
  }));
  for (const p of target) {
    if (p.inZone) continue;
    const key = stratum(p);
    const c = course.get(key);
    const e = expectation.get(JSON.stringify([key, p.expectedInZone]));
    for (const g of tallies) {
      if (g.key !== "outside" && g.key !== (p.expectedInZone ? "in-out" : "out-out")) continue;
      g.pitches++;
      g.swings += Number(p.swing);
      // Both estimates must describe the same target pitches and use the same eligible
      // league pool. Only the additional expected-zone condition changes between them.
      if (c === undefined || e === undefined || c.pitches < minControls || e.pitches < minControls)
        continue;
      g.matchedPitches++;
      g.matchedSwings += Number(p.swing);
      g.courseExpected += c.swings / c.pitches;
      g.expectationExpected += e.swings / e.pitches;
    }
  }
  return {
    conventional: {
      batter: courseRates(targetRows.filter((p) => p.eligible)),
      league: courseRates(controlRows.filter((p) => p.eligible)),
    },
    common: { batter: courseRates(target), league: courseRates(league) },
    paired: tallies.map(({ courseExpected, expectationExpected, ...g }) => ({
      ...g,
      matchedSwingRate: rate(g.matchedSwings, g.matchedPitches),
      courseLeagueSwingRate: rate(courseExpected, g.matchedPitches),
      expectationLeagueSwingRate: rate(expectationExpected, g.matchedPitches),
      courseDifference: rate(g.matchedSwings - courseExpected, g.matchedPitches),
      expectationDifference: rate(g.matchedSwings - expectationExpected, g.matchedPitches),
    })),
  };
}
