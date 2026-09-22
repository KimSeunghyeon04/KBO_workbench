import type {
  PitchOutcomeQuery,
  PitchOutcomeRow,
  TerminalPaRow,
  PitchRateGroup,
  PitchLocationPoint,
  PitchLocationResponse,
  AnalysisScope,
} from "@kbo/contracts";
import { observedPitchLocation } from "./pitch-location.js";
const key = (r: { gameId: string; revision: number; pitchId: string }) =>
  JSON.stringify([r.gameId, r.revision, r.pitchId]);
const divide = (n: number, d: number) => (d === 0 ? null : n / d);
const inPlayResults = new Set([
  "single",
  "double",
  "triple",
  "home_run",
  "field_out",
  "sacrifice_bunt",
  "sacrifice_fly",
  "fielder_choice",
  "reached_on_error",
  "double_play",
  "triple_play",
]);
const hits = new Set(["single", "double", "triple", "home_run"]);
/** Associate only an observed terminal event compatible with the compiler's completed PA and count. */
export function hasTerminalPitch(
  pa: Pick<
    TerminalPaRow,
    "completed" | "pitchId" | "result" | "afterStrikes" | "afterBalls" | "pitchCall" | "inPlay"
  >,
): boolean {
  if (!pa.completed || pa.pitchId === null) return false;
  if (pa.result === "strikeout") return pa.afterStrikes === 3;
  if (pa.result === "walk") return pa.afterBalls === 4;
  if (pa.result === "hit_by_pitch") return pa.pitchCall === "hit_by_pitch";
  return pa.result !== null && inPlayResults.has(pa.result) && pa.inPlay === true;
}
export function matchesPitchOutcome(
  row: Pick<PitchOutcomeRow, "balls" | "strikes" | "pitchType" | "stance">,
  query: PitchOutcomeQuery,
) {
  return (
    (query.balls === undefined || query.balls === row.balls) &&
    (query.strikes === undefined || query.strikes === row.strikes) &&
    (query.pitchType === undefined || query.pitchType === row.pitchType) &&
    (query.stance === undefined || query.stance === row.stance)
  );
}
export function pitchOutcomeSummarizer(pas: readonly TerminalPaRow[]) {
  const terminal = new Map(
    pas.flatMap((pa) =>
      hasTerminalPitch(pa) && pa.terminalActual === true && pa.pitchId !== null
        ? [[key({ gameId: pa.gameId, revision: pa.revision, pitchId: pa.pitchId }), pa] as const]
        : [],
    ),
  );
  return (groupKey: string, selected: readonly PitchOutcomeRow[]): PitchRateGroup => {
    let swings = 0,
      whiffs = 0,
      calledStrikes = 0,
      csw = 0,
      inPlay = 0,
      zoneKnown = 0,
      zonePitches = 0,
      zoneSwings = 0,
      outsidePitches = 0,
      outsideSwings = 0;
    let twoStrikePitches = 0,
      terminalStrikeouts = 0,
      results = 0,
      inPlayHits = 0;
    for (const row of selected) {
      swings += Number(row.swing);
      whiffs += Number(row.whiff);
      calledStrikes += Number(row.calledStrike);
      csw += Number(row.csw);
      inPlay += Number(row.inPlay);
      if (row.inZone !== null) {
        zoneKnown++;
        if (row.inZone) {
          zonePitches++;
          zoneSwings += Number(row.swing);
        } else {
          outsidePitches++;
          outsideSwings += Number(row.swing);
        }
      }
      if (row.strikes === 2) twoStrikePitches++;
      const pa = terminal.get(key(row));
      if (pa?.result === "strikeout" && row.strikes === 2) terminalStrikeouts++;
      if (pa?.result !== undefined && pa.result !== null && inPlayResults.has(pa.result)) {
        results++;
        inPlayHits += Number(hits.has(pa.result));
      }
    }
    const pitches = selected.length;
    return {
      key: groupKey,
      pitches,
      swings,
      whiffs,
      calledStrikes,
      csw,
      inPlay,
      zoneKnown,
      zonePitches,
      zoneSwings,
      outsidePitches,
      outsideSwings,
      twoStrikePitches,
      terminalStrikeouts,
      inPlayResults: results,
      inPlayHits,
      swingRate: divide(swings, pitches),
      whiffRate: divide(whiffs, swings),
      swingingStrikeRate: divide(whiffs, pitches),
      calledStrikeRate: divide(calledStrikes, pitches),
      cswRate: divide(csw, pitches),
      zoneRate: divide(zonePitches, zoneKnown),
      chaseRate: divide(outsideSwings, outsidePitches),
      zoneSwingRate: divide(zoneSwings, zonePitches),
      putAwayRate: divide(terminalStrikeouts, twoStrikePitches),
      inPlayHitRate: divide(inPlayHits, results),
    };
  };
}
export function analyzePitchLocation(
  query: PitchOutcomeQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly PitchOutcomeRow[],
  pas: readonly TerminalPaRow[],
): PitchLocationResponse {
  const filtered = rows.filter((r) => matchesPitchOutcome(r, query));
  const selected = filtered.filter((r) => query.cohort !== "discipline" || r.eligible);
  const points: PitchLocationPoint[] = [];
  const cellRows = Array.from({ length: 25 }, () => [] as PitchOutcomeRow[]);
  for (const row of selected) {
    const location = observedPitchLocation(row);
    if (location === null) continue;
    points.push({
      gameId: row.gameId,
      revision: row.revision,
      pitchId: row.pitchId,
      gameDate: row.gameDate,
      pitchType: row.pitchType,
      speedKph: row.speedKph,
      balls: row.balls,
      strikes: row.strikes,
      stance: row.stance,
      swing: row.swing,
      whiff: row.whiff,
      cell: location.cell,
      xCm: location.xCm,
      zCm: location.zCm,
      normalizedX: location.normalizedX,
      normalizedZ: location.normalizedZ,
      inZone: location.inZone,
    });
    cellRows[location.cell]?.push(row);
  }
  const summarize = pitchOutcomeSummarizer(pas);
  const group = (getKey: (r: PitchOutcomeRow) => string) => {
    const map = new Map<string, PitchOutcomeRow[]>();
    for (const row of selected) {
      const id = getKey(row),
        values = map.get(id) ?? [];
      values.push(row);
      map.set(id, values);
    }
    return [...map]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, values]) => summarize(id, values));
  };
  const automaticStrikeouts = pas.filter(
    (pa) =>
      (query.cohort !== "discipline" || pa.eligible) &&
      hasTerminalPitch(pa) &&
      pa.terminalActual === false &&
      pa.result === "strikeout" &&
      pa.terminalPitcherId === pitcherId &&
      pa.beforeBalls !== null &&
      pa.beforeStrikes !== null &&
      matchesPitchOutcome(
        {
          balls: pa.beforeBalls,
          strikes: pa.beforeStrikes,
          pitchType: pa.pitchType,
          stance: pa.stance,
        },
        query,
      ),
  ).length;
  return {
    query,
    pitcherId,
    scope,
    sourceHash,
    coverage: {
      scopePitches: rows.length,
      filteredPitches: filtered.length,
      excludedSituations: filtered.length - selected.length,
      locationPitches: points.length,
      missingLocation: selected.length - points.length,
      automaticStrikeouts,
    },
    total: summarize("all", selected),
    byType: group((r) => r.pitchType ?? "구종 미상"),
    byCount: group((r) => `${r.balls}-${r.strikes}`),
    byStance: group((r) => r.stance ?? "미상"),
    cells: cellRows.map((values, index) => summarize(String(index), values)),
    points,
  };
}
