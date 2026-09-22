import { resolveAnalysisScope, type AnalysisScopeOptions } from "@kbo/contracts";
import {
  canonicalStringify,
  DisciplineCatalogSchema,
  DisciplineResponseSchema,
  type DisciplineQuery,
  type DisciplineResponse,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "./transport";

export async function getDisciplineCatalog(
  season: number,
  signal: AbortSignal,
  options: AnalysisScopeOptions = {},
) {
  const result = Value.Decode(
    DisciplineCatalogSchema,
    await requestJson(
      `/api/v2/analysis/batter-discipline?${new URLSearchParams(Object.entries({ season, ...options }).map(([k, v]) => [k, String(v)]))}`,
      { signal },
    ),
  );
  if (
    result.season !== season ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope({ season, ...options }))
  )
    throw new Error("선구안 시즌이 요청과 일치하지 않습니다.");
  return result;
}
export async function getBatterDiscipline(
  query: DisciplineQuery,
  batterId: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    DisciplineResponseSchema,
    await requestJson(
      `/api/v2/analysis/batter-discipline/${encodeURIComponent(batterId)}?${params}`,
      { signal },
    ),
  );
  if (
    result.batterId !== batterId ||
    canonicalStringify(result.query) !== canonicalStringify(query)
  )
    throw new Error("선구안 분석 대상이 요청과 일치하지 않습니다.");
  validateDisciplineResponse(result);
  return result;
}
export function validateDisciplineResponse(result: DisciplineResponse): void {
  const { coverage: c, points } = result;
  const invalid = () => {
    throw new Error("선구안 표본 집계가 일치하지 않습니다.");
  };
  if (
    c.actualPitches !== c.excludedSituations + c.missingLocation + c.locationPitches ||
    c.locationPitches !== points.length ||
    c.comparisonPitches !== points.filter((p) => p.expectedInZone !== null).length ||
    new Set(points.map((p) => JSON.stringify([p.gameId, p.revision, p.pitchId]))).size !==
      points.length ||
    points.some((p) => p.whiff && !p.swing)
  )
    invalid();
  for (const groups of [
    result.summary,
    result.cells,
    result.transitions,
    ...Object.values(result.deviations),
  ]) {
    for (const g of groups) {
      if (
        g.swings > g.pitches ||
        g.whiffs > g.swings ||
        g.matchedPitches > g.pitches ||
        g.matchedSwings > g.matchedPitches ||
        g.swingRate !== (g.pitches ? g.swings / g.pitches : null) ||
        g.whiffRate !== (g.swings ? g.whiffs / g.swings : null) ||
        g.matchedSwingRate !== (g.matchedPitches ? g.matchedSwings / g.matchedPitches : null) ||
        (g.matchedPitches === 0) !== (g.leagueSwingRate === null) ||
        (g.matchedPitches === 0) !== (g.difference === null) ||
        (g.leagueSwingRate !== null && (g.leagueSwingRate < 0 || g.leagueSwingRate > 1)) ||
        (g.difference !== null &&
          Math.abs(g.difference - ((g.matchedSwingRate ?? 0) - (g.leagueSwingRate ?? 0))) > 1e-10)
      )
        invalid();
    }
  }
  const check = (groups: DisciplineResponse["cells"], expected: number) => {
    if (
      new Set(groups.map((g) => g.key)).size !== groups.length ||
      groups.reduce((n, g) => n + g.pitches, 0) !== expected
    )
      invalid();
  };
  check(result.summary, points.length);
  check(result.cells, points.length);
  check(result.transitions, c.comparisonPitches);
  for (const groups of Object.values(result.deviations)) check(groups, c.comparisonPitches);
  if (
    result.cells.length !== 25 ||
    result.summary.length !== 2 ||
    result.transitions.length !== 4 ||
    Object.values(result.deviations).some((g) => g.length !== 6)
  )
    invalid();
  for (const g of result.cells) {
    const rows = points.filter((p) => String(p.cell) === g.key);
    if (rows.length !== g.pitches || rows.filter((p) => p.swing).length !== g.swings) invalid();
  }
  validateCourseComparison(result, invalid);
}

function validateCourseComparison(result: DisciplineResponse, invalid: () => void): void {
  const { conventional, common, paired } = result.courseComparison;
  const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
  for (const r of [conventional.batter, conventional.league, common.batter, common.league]) {
    if (
      r.pitches !== r.zonePitches + r.outsidePitches ||
      r.swings !== r.zoneSwings + r.outsideSwings ||
      r.zoneSwings > r.zonePitches ||
      r.outsideSwings > r.outsidePitches ||
      r.zoneRate !== ratio(r.zonePitches, r.pitches) ||
      r.swingRate !== ratio(r.swings, r.pitches) ||
      r.chaseRate !== ratio(r.outsideSwings, r.outsidePitches) ||
      r.zoneSwingRate !== ratio(r.zoneSwings, r.zonePitches)
    )
      invalid();
  }
  const points = result.points.filter((p) => p.expectedInZone !== null);
  if (
    conventional.batter.pitches >
      result.coverage.actualPitches - result.coverage.excludedSituations ||
    conventional.batter.pitches < result.coverage.locationPitches ||
    common.batter.pitches !== points.length ||
    common.batter.swings !== points.filter((p) => p.swing).length ||
    common.batter.zonePitches !== points.filter((p) => p.inZone).length ||
    common.batter.zoneSwings !== points.filter((p) => p.inZone && p.swing).length ||
    common.league.pitches > conventional.league.pitches ||
    common.league.pitches > result.coverage.leagueLocationPitches ||
    paired.map((g) => g.key).join(",") !== "outside,in-out,out-out"
  )
    invalid();
  for (const g of paired) {
    const rows = points.filter(
      (p) =>
        !p.inZone && (g.key === "outside" || g.key === (p.expectedInZone ? "in-out" : "out-out")),
    );
    if (
      g.pitches !== rows.length ||
      g.swings !== rows.filter((p) => p.swing).length ||
      g.matchedPitches > g.pitches ||
      g.matchedSwings > g.matchedPitches ||
      g.matchedSwings > g.swings ||
      g.swings - g.matchedSwings > g.pitches - g.matchedPitches ||
      g.matchedSwingRate !== ratio(g.matchedSwings, g.matchedPitches)
    )
      invalid();
    for (const [leagueRate, difference] of [
      [g.courseLeagueSwingRate, g.courseDifference],
      [g.expectationLeagueSwingRate, g.expectationDifference],
    ] as const) {
      if (
        (g.matchedPitches === 0) !== (leagueRate === null) ||
        (g.matchedPitches === 0) !== (difference === null) ||
        (leagueRate !== null && (leagueRate < 0 || leagueRate > 1)) ||
        (difference !== null &&
          Math.abs(difference - ((g.matchedSwingRate ?? 0) - (leagueRate ?? 0))) > 1e-10)
      )
        invalid();
    }
  }
  const [all, ...parts] = paired;
  if (all === undefined) {
    invalid();
    return;
  }
  for (const key of ["pitches", "swings", "matchedPitches", "matchedSwings"] as const) {
    if (all[key] !== parts.reduce((n, p) => n + p[key], 0)) invalid();
  }
  for (const key of ["courseLeagueSwingRate", "expectationLeagueSwingRate"] as const) {
    const expected = parts.reduce((n, p) => n + (p[key] ?? 0) * p.matchedPitches, 0);
    if (Math.abs((all[key] ?? 0) * all.matchedPitches - expected) > 1e-8) invalid();
  }
}
