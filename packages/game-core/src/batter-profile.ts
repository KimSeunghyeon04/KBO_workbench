import type {
  AnalysisScope,
  PitchOutcomeQuery,
  PitchOutcomeRow,
  TerminalPaRow,
  TerminalBattingGroup,
  BatterProfileResponse,
} from "@kbo/contracts";
import {
  analyzePitchLocation,
  hasTerminalPitch,
  matchesPitchOutcome,
  pitchOutcomeSummarizer,
} from "./pitch-outcomes.js";
function batting(key: string, rows: readonly TerminalPaRow[]): TerminalBattingGroup {
  let ab = 0,
    hits = 0,
    totalBases = 0,
    walks = 0,
    strikeouts = 0,
    hitByPitch = 0,
    homeRuns = 0;
  for (const row of rows) {
    ab += Number(row.countsAsAb);
    const r = row.result;
    const bases =
      r === "single" ? 1 : r === "double" ? 2 : r === "triple" ? 3 : r === "home_run" ? 4 : 0;
    hits += Number(bases > 0);
    totalBases += bases;
    walks += Number(r === "walk" || r === "intentional_walk");
    strikeouts += Number(r === "strikeout");
    hitByPitch += Number(r === "hit_by_pitch");
    homeRuns += Number(r === "home_run");
  }
  return {
    key,
    pa: rows.length,
    ab,
    hits,
    totalBases,
    walks,
    strikeouts,
    hitByPitch,
    homeRuns,
    avg: ab === 0 ? null : hits / ab,
    slg: ab === 0 ? null : totalBases / ab,
  };
}
export function analyzeBatterProfile(
  query: PitchOutcomeQuery,
  batterId: string,
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly PitchOutcomeRow[],
  pas: readonly TerminalPaRow[],
): BatterProfileResponse {
  const { pitcherId, ...location } = analyzePitchLocation(query, "", scope, sourceHash, rows, pas);
  void pitcherId;
  const own = pas.filter((p) => p.batterId === batterId),
    complete = own.filter((p) => p.completed && p.countsAsPa);
  // Official attribution follows the compiler's PA owner. A replacement batter's final pitch does not transfer its type.
  const details = complete.map((pa) => ({
    ...pa,
    terminalType:
      hasTerminalPitch(pa) && pa.terminalActual === true && pa.terminalBatterId === batterId
        ? (pa.pitchType ?? "구종 미상")
        : "미귀속",
  }));
  const types = new Map<string, TerminalPaRow[]>();
  for (const pa of details) {
    const group = types.get(pa.terminalType) ?? [];
    group.push(pa);
    types.set(pa.terminalType, group);
  }
  const speed = new Map<string, PitchOutcomeRow[]>();
  for (const row of rows) {
    if (!matchesPitchOutcome(row, query) || (query.cohort === "discipline" && !row.eligible))
      continue;
    const key =
      row.speedKph === null
        ? "구속 미상"
        : `${Math.floor(row.speedKph / 5) * 5}–${Math.floor(row.speedKph / 5) * 5 + 5} km/h`;
    const group = speed.get(key) ?? [];
    group.push(row);
    speed.set(key, group);
  }
  const summarize = pitchOutcomeSummarizer(pas);
  return {
    ...location,
    batterId,
    coverage: {
      ...location.coverage,
      automaticStrikeouts: own.filter(
        (p) => hasTerminalPitch(p) && p.terminalActual === false && p.result === "strikeout",
      ).length,
    },
    bySpeed: [...speed]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, group]) => summarize(key, group)),
    plateAppearances: {
      total: batting("all", complete),
      partial: own.filter((p) => !p.completed).length,
      unattributed: details.filter((p) => p.terminalType === "미귀속").length,
      byTerminalType: [...types]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, group]) => batting(key, group)),
      rows: details,
    },
  };
}
