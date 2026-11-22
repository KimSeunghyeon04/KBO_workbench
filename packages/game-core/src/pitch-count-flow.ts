import {
  compareCanonicalStrings,
  pitchCountOutcomes,
  pitchCountTerminalOutcomes,
  type AnalysisScope,
  type BatterCountFlowQuery,
  type BatterCountFlowResponse,
  type BatterCountFlowRow,
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
    swings: 0,
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
  swing: boolean,
) {
  counts.transitions[result]++;
  counts.swings += Number(swing);
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
  return {
    query,
    pitcherId,
    scope,
    sourceHash,
    ...countFlowSamples(
      query,
      rows,
      ({ stance }): Stance[] => (stance === "L" || stance === "R" ? ["all", stance] : ["all"]),
      summary,
    ),
  };
}

export function analyzeBatterCountFlow(
  query: BatterCountFlowQuery,
  batterId: string,
  scope: AnalysisScope,
  sourceHash: string,
  rows: readonly BatterCountFlowRow[],
): BatterCountFlowResponse {
  const { groups, ...counts } = countFlowSamples(
    query,
    rows,
    ({ pitcherHand }): Stance[] =>
      query.split !== undefined && pitcherHand != null ? ["all", pitcherHand] : ["all"],
    (counts) => {
      const total = summary(counts);
      return { ...total, swings: counts.swings, swingRate: counts.swings / total.pitches };
    },
  );
  const forSide = (side: Stance) =>
    groups
      .filter((group) => group.stance === side)
      .map((group) => ({ ...group, stance: "all" as const }));
  const response = {
    query,
    batterId,
    scope,
    sourceHash,
    ...counts,
    groups: forSide("all"),
  };
  if (query.split === undefined) return response;
  const left = forSide("L");
  const right = forSide("R");
  const knownPitches = [...left, ...right].reduce((total, group) => total + group.pitches, 0);
  return {
    ...response,
    byPitcherHand: {
      left,
      right,
      unknownPitches: counts.scopePitches - counts.excludedSituations - knownPitches,
    },
  };
}

function countFlowSamples<
  Row extends PitchCountFlowRow,
  S extends Stance,
  Summary extends ReturnType<typeof summary>,
>(
  query: PitchCountFlowQuery,
  rows: readonly Row[],
  stancesFor: (row: Row) => readonly S[],
  summarize: (counts: SampleCounts) => Summary,
) {
  const selected = query.cohort === "discipline" ? rows.filter((row) => row.eligible) : rows;
  const detailed = query.include === "terminal-details";
  const groups = new Map<
    string,
    {
      stance: S;
      balls: number;
      strikes: number;
      counts: SampleCounts;
      types: Map<string | null, SampleCounts>;
    }
  >();
  for (const row of selected) {
    const result = outcome(row);
    const detail = detailed ? terminalOutcome(result, row) : undefined;
    const swing = "swing" in row && row.swing === true;
    for (const stance of stancesFor(row)) {
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
      record(group.counts, result, detail, swing);
      let counts = group.types.get(row.pitchType);
      if (!counts) {
        counts = emptyCounts(detailed);
        group.types.set(row.pitchType, counts);
      }
      record(counts, result, detail, swing);
    }
  }
  const summaries = [...groups.values()]
    .sort(
      (a, b) =>
        compareCanonicalStrings(a.stance, b.stance) || a.strikes - b.strikes || a.balls - b.balls,
    )
    .map(({ counts, types, ...group }) => {
      const total = summarize(counts);
      return {
        ...group,
        ...total,
        types: [...types]
          .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : compareCanonicalStrings(a, b)))
          .map(([pitchType, counts]) => {
            const type = summarize(counts);
            return { pitchType, ...type, usageRate: type.pitches / total.pitches };
          }),
      };
    });
  return {
    scopePitches: rows.length,
    excludedSituations: rows.length - selected.length,
    groups: summaries,
  };
}
