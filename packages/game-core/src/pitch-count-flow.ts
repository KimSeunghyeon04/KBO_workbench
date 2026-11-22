import {
  compareCanonicalStrings,
  pitchCountOutcomes,
  type AnalysisScope,
  type PitchCountOutcome,
  type PitchCountFlowGroup,
  type PitchCountFlowQuery,
  type PitchCountFlowResponse,
  type PitchCountFlowRow,
} from "@kbo/contracts";
import { hasTerminalPitch } from "./pitch-outcomes.js";

type Stance = PitchCountFlowGroup["stance"];
type Counts = Record<PitchCountOutcome, number>;
const emptyCounts = (): Counts => ({
  ball: 0,
  strike: 0,
  foul: 0,
  walk: 0,
  strikeout: 0,
  inPlay: 0,
  hitByPitch: 0,
  unresolved: 0,
});

function outcome(row: PitchCountFlowRow): PitchCountOutcome {
  if (row.terminalResult === "hit_by_pitch") return "hitByPitch";
  if (hasTerminalPitch({ ...row, completed: true, result: row.terminalResult })) {
    if (row.terminalResult === "strikeout") return "strikeout";
    if (row.terminalResult === "walk") return "walk";
    if (row.inPlay) return "inPlay";
  }
  // The compiler's after state belongs to this pitch, even if the next event
  // is an automatic call, a substitution, or the end of a partial PA.
  const { balls, strikes, afterBalls, afterStrikes } = row;
  if (afterBalls === balls + 1 && afterBalls < 4 && afterStrikes === strikes) return "ball";
  if (afterStrikes === strikes + 1 && afterStrikes < 3 && afterBalls === balls) return "strike";
  if (strikes === 2 && afterStrikes === strikes && afterBalls === balls && row.pitchCall === "foul")
    return "foul";
  return "unresolved";
}

function summary(counts: Counts) {
  const pitches = pitchCountOutcomes.reduce((total, key) => total + counts[key], 0);
  return {
    pitches,
    transitions: pitchCountOutcomes.map((outcome) => ({
      outcome,
      pitches: counts[outcome],
      rate: counts[outcome] / pitches,
    })),
  };
}

export function analyzePitchCountFlow(
  query: PitchCountFlowQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly PitchCountFlowRow[],
): PitchCountFlowResponse {
  const selected = query.cohort === "discipline" ? rows.filter((row) => row.eligible) : rows;
  return {
    query,
    pitcherId,
    scope,
    sourceHash,
    scopePitches: rows.length,
    excludedSituations: rows.length - selected.length,
    groups: summarizePitchCountFlow(selected),
  };
}

function summarizePitchCountFlow(rows: readonly PitchCountFlowRow[]): PitchCountFlowGroup[] {
  const groups = new Map<
    string,
    {
      stance: Stance;
      balls: number;
      strikes: number;
      counts: Counts;
      types: Map<string | null, Counts>;
    }
  >();
  for (const row of rows) {
    const result = outcome(row);
    const stances: Stance[] =
      row.stance === "L" || row.stance === "R" ? ["all", row.stance] : ["all"];
    for (const stance of stances) {
      const key = JSON.stringify([stance, row.balls, row.strikes]);
      let group = groups.get(key);
      if (!group) {
        group = {
          stance,
          balls: row.balls,
          strikes: row.strikes,
          counts: emptyCounts(),
          types: new Map(),
        };
        groups.set(key, group);
      }
      group.counts[result]++;
      let counts = group.types.get(row.pitchType);
      if (!counts) {
        counts = emptyCounts();
        group.types.set(row.pitchType, counts);
      }
      counts[result]++;
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        compareCanonicalStrings(a.stance, b.stance) || a.strikes - b.strikes || a.balls - b.balls,
    )
    .map(({ counts, types, ...group }) => {
      const total = summary(counts);
      return {
        ...group,
        ...total,
        types: [...types]
          .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : compareCanonicalStrings(a, b)))
          .map(([pitchType, counts]) => {
            const type = summary(counts);
            return { pitchType, ...type, usageRate: type.pitches / total.pitches };
          }),
      };
    });
}
