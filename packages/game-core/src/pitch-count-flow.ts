import {
  compareCanonicalStrings,
  pitchCountOutcomes,
  pitchCountTerminalOutcomes,
  type AnalysisScope,
  type PitchCountOutcome,
  type PitchCountFlowGroup,
  type PitchCountFlowQuery,
  type PitchCountFlowResponse,
  type PitchCountFlowRow,
  type PitchCountTerminalOutcome,
} from "@kbo/contracts";
import { hasTerminalPitch } from "./pitch-outcomes.js";

type Stance = PitchCountFlowGroup["stance"];
type Counts = Record<PitchCountOutcome, number>;
function emptyCounts(detailed: boolean) {
  const transitions: Counts = {
    ball: 0,
    strike: 0,
    foul: 0,
    walk: 0,
    strikeout: 0,
    inPlay: 0,
    hitByPitch: 0,
    unresolved: 0,
  };
  return {
    transitions,
    details: detailed ? new Map<PitchCountTerminalOutcome, number>() : undefined,
  };
}
type SampleCounts = ReturnType<typeof emptyCounts>;
const terminalOutcomes = [
  ...pitchCountTerminalOutcomes.strikeout,
  ...pitchCountTerminalOutcomes.inPlay,
];

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

function terminalOutcome(
  outcome: PitchCountOutcome,
  row: PitchCountFlowRow,
): PitchCountTerminalOutcome | undefined {
  if (outcome === "strikeout") {
    if (row.pitchCall === "called_strike") return "lookingStrikeout";
    if (row.pitchCall === "swinging_strike") return "swingingStrikeout";
    return "otherStrikeout";
  }
  if (outcome !== "inPlay") return undefined;
  switch (row.terminalResult) {
    case "single":
    case "double":
    case "triple":
      return row.terminalResult;
    case "home_run":
      return "homeRun";
    case "field_out":
    case "double_play":
    case "triple_play":
      return "battedOut";
    case "sacrifice_bunt":
    case "sacrifice_fly":
      return "sacrifice";
    case "reached_on_error":
      return "reachedOnError";
    case "fielder_choice":
      return "fielderChoice";
    default:
      return "otherInPlay";
  }
}

function record(
  counts: SampleCounts,
  result: PitchCountOutcome,
  detail: PitchCountTerminalOutcome | undefined,
) {
  counts.transitions[result]++;
  if (detail !== undefined) counts.details?.set(detail, (counts.details.get(detail) ?? 0) + 1);
}

function summary({ transitions, details }: SampleCounts) {
  const pitches = pitchCountOutcomes.reduce((total, key) => total + transitions[key], 0);
  return {
    pitches,
    transitions: pitchCountOutcomes.map((outcome) => ({
      outcome,
      pitches: transitions[outcome],
      rate: transitions[outcome] / pitches,
    })),
    ...(details === undefined
      ? {}
      : {
          terminalDetails: terminalOutcomes.flatMap((outcome) => {
            const count = details.get(outcome);
            return count === undefined ? [] : [{ outcome, pitches: count, rate: count / pitches }];
          }),
        }),
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
    groups: summarizePitchCountFlow(selected, query.include === "terminal-details"),
  };
}

function summarizePitchCountFlow(
  rows: readonly PitchCountFlowRow[],
  detailed: boolean,
): PitchCountFlowGroup[] {
  const groups = new Map<
    string,
    {
      stance: Stance;
      balls: number;
      strikes: number;
      counts: SampleCounts;
      types: Map<string | null, SampleCounts>;
    }
  >();
  for (const row of rows) {
    const result = outcome(row);
    const detail = detailed ? terminalOutcome(result, row) : undefined;
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
          counts: emptyCounts(detailed),
          types: new Map(),
        };
        groups.set(key, group);
      }
      record(group.counts, result, detail);
      let counts = group.types.get(row.pitchType);
      if (!counts) {
        counts = emptyCounts(detailed);
        group.types.set(row.pitchType, counts);
      }
      record(counts, result, detail);
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
