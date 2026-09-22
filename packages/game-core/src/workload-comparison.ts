import type {
  AnalysisScope,
  AnalysisScopeQuery,
  WorkloadAppearance,
  WorkloadComparisonCell,
  WorkloadComparisonDimension,
  WorkloadComparisonResponse,
} from "@kbo/contracts";
import { workloadCalendar } from "./workload-calendar.js";
import {
  workloadContrastInterval,
  type WorkloadContrastGame,
} from "./workload-comparison-interval.js";

export const WORKLOAD_COMPARISON_POLICY = {
  minCellSamples: 5,
  minGroupSamples: 50,
  minGroupGames: 5,
  bootstrapReplicates: 600,
  minValidReplicates: 480,
  weighting: "minimum_group_samples",
  conditions: "pitcher_season_entry_role_pitch_type_stance_count",
} as const;
type Dimension = WorkloadComparisonResponse["dimensions"][number];
type Contrast = Dimension["comparisons"][number];
type Metric = Contrast["metric"];
type Calendar = ReturnType<typeof workloadCalendar>;
type DateLoad = NonNullable<ReturnType<Calendar["get"]>>;
type Row = WorkloadComparisonCell & { game: string; stratum: string; load: DateLoad };
type Tally = { samples: number; sum: number; games: Set<string> };
const empty = (): Tally => ({ samples: 0, sum: 0, games: new Set() });
const key = (r: { gameId: string; revision: number }) => JSON.stringify([r.gameId, r.revision]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function observation(row: Row, metric: Metric) {
  return metric === "speed"
    ? { samples: row.speedCount, sum: row.speedSum }
    : metric === "swing"
      ? { samples: row.pitches, sum: row.swings }
      : { samples: row.swings, sum: row.whiffs };
}
function group(row: Row, dimension: WorkloadComparisonDimension): string | null {
  if (dimension === "pitchNumber")
    return ["1–25", "26–50", "51–75", "76+"][row.pitchBucket] ?? null;
  if (dimension === "meeting") return row.meeting === null ? null : String(row.meeting);
  // A same-day earlier appearance is unknowable here. Do not silently assign it zero workload.
  if (row.load.previousObservedDate === null || row.load.sameDayAppearances > 1) return null;
  if (dimension === "rest") {
    const rest = row.load.observedRestDays;
    return rest === null ? null : rest === 0 ? "0" : rest === 1 ? "1" : "2+";
  }
  const pitches =
    dimension === "previous3Days" ? row.load.previous3DaysPitches : row.load.previous7DaysPitches;
  return pitches < 30 ? "0–29" : pitches < 60 ? "30–59" : "60+";
}
function add(tally: Tally, samples: number, sum: number, game: string) {
  tally.samples += samples;
  tally.sum += sum;
  if (samples > 0) tally.games.add(game);
}
function contrast(
  rows: readonly Row[],
  dimension: WorkloadComparisonDimension,
  reference: string,
  comparison: string,
  metric: Metric,
): Contrast {
  const all: [Tally, Tally] = [empty(), empty()],
    strata = new Map<
      string,
      {
        tallies: [Tally, Tally];
        rows: { game: string; arm: 0 | 1; samples: number; sum: number }[];
      }
    >();
  for (const row of rows) {
    const selected = group(row, dimension);
    if (selected !== reference && selected !== comparison) continue;
    const arm = selected === reference ? 0 : 1,
      { samples, sum } = observation(row, metric);
    if (samples === 0) continue;
    add(all[arm], samples, sum, row.game);
    const cell = strata.get(row.stratum) ?? { tallies: [empty(), empty()], rows: [] };
    add(cell.tallies[arm], samples, sum, row.game);
    cell.rows.push({ game: row.game, arm, samples, sum });
    strata.set(row.stratum, cell);
  }
  const matched: [Tally, Tally] = [empty(), empty()],
    games = new Map<string, WorkloadContrastGame>(),
    weights: number[] = [],
    adjusted = [0, 0];
  for (const stratum of [...strata.keys()].sort(order)) {
    const cell = strata.get(stratum);
    if (
      cell === undefined ||
      cell.tallies.some((t) => t.samples < WORKLOAD_COMPARISON_POLICY.minCellSamples)
    )
      continue;
    const index = weights.length,
      weight = Math.min(cell.tallies[0].samples, cell.tallies[1].samples);
    weights.push(weight);
    for (const arm of [0, 1] as const) {
      const tally = cell.tallies[arm];
      matched[arm].samples += tally.samples;
      for (const game of tally.games) matched[arm].games.add(game);
      adjusted[arm] = (adjusted[arm] ?? 0) + (weight * tally.sum) / tally.samples;
    }
    for (const row of cell.rows) {
      const game = games.get(row.game) ?? { cells: [] };
      game.cells.push({ index: index * 2 + row.arm, samples: row.samples, sum: row.sum });
      games.set(row.game, game);
    }
  }
  const overlapWeight = weights.reduce((a, b) => a + b, 0),
    supported =
      overlapWeight > 0 &&
      matched.every(
        (t) =>
          t.samples >= WORKLOAD_COMPARISON_POLICY.minGroupSamples &&
          t.games.size >= WORKLOAD_COMPARISON_POLICY.minGroupGames,
      ),
    uncertainty = supported
      ? workloadContrastInterval(
          [...games.keys()].sort(order).map((k) => {
            const game = games.get(k);
            if (game === undefined) throw new Error("Missing contrast game");
            return game;
          }),
          weights,
          WORKLOAD_COMPARISON_POLICY.bootstrapReplicates,
        )
      : { interval: null, validReplicates: 0 },
    status = !supported
      ? "insufficient_support"
      : uncertainty.validReplicates < WORKLOAD_COMPARISON_POLICY.minValidReplicates
        ? "unstable_interval"
        : "ready";
  const summary = (arm: 0 | 1): Contrast["baseline"] => ({
    samples: all[arm].samples,
    games: all[arm].games.size,
    rawMean: all[arm].samples === 0 ? null : all[arm].sum / all[arm].samples,
    matchedSamples: matched[arm].samples,
    matchedGames: matched[arm].games.size,
    adjustedMean: status === "ready" ? (adjusted[arm] ?? 0) / overlapWeight : null,
  });
  return {
    reference,
    comparison,
    metric,
    status,
    baseline: summary(0),
    target: summary(1),
    commonStrata: weights.length,
    overlapWeight,
    difference:
      status === "ready" ? ((adjusted[1] ?? 0) - (adjusted[0] ?? 0)) / overlapWeight : null,
    interval: status === "ready" ? uncertainty.interval : null,
    validReplicates: uncertainty.validReplicates,
  };
}

export function comparePitcherWorkload(
  query: AnalysisScopeQuery,
  scope: AnalysisScope,
  pitcherId: string,
  sourceHash: string,
  history: readonly WorkloadAppearance[],
  cells: readonly WorkloadComparisonCell[],
): WorkloadComparisonResponse {
  const cutoff = scope.dateTo ?? `${scope.season}-12-31`,
    start = scope.dateFrom ?? `${scope.season}-01-01`,
    calendar = workloadCalendar(history, cutoff),
    appearances = new Map(history.map((r) => [key(r), r])),
    roleEvidence = { registeredPitches: 0, observedPitches: 0, unknownPitches: 0 },
    rows: Row[] = [];
  let actualPitches = 0,
    excludedConditionPitches = 0;
  for (const cell of cells) {
    const appearance = appearances.get(key(cell));
    if (appearance === undefined) throw new Error("Comparison cell has no observed appearance");
    if (appearance.gameDate < start || appearance.gameDate > cutoff) continue;
    if (
      cell.whiffs > cell.swings ||
      cell.swings > cell.pitches ||
      cell.speedCount > cell.pitches ||
      (cell.speedCount === 0 && cell.speedSum !== 0)
    )
      throw new Error("Invalid workload cell denominators");
    actualPitches += cell.pitches;
    const role = appearance.role === "unknown" ? cell.observedRole : appearance.role;
    if (appearance.role !== "unknown") roleEvidence.registeredPitches += cell.pitches;
    else if (role !== "unknown") roleEvidence.observedPitches += cell.pitches;
    else roleEvidence.unknownPitches += cell.pitches;
    if (
      role === "unknown" ||
      cell.pitchType === null ||
      cell.pitchType.trim() === "" ||
      (cell.stance !== "L" && cell.stance !== "R")
    ) {
      excludedConditionPitches += cell.pitches;
      continue;
    }
    const load = calendar.get(appearance.gameDate);
    if (load === undefined) throw new Error("Missing comparison calendar date");
    rows.push({
      ...cell,
      game: key(cell),
      stratum: JSON.stringify([role, cell.pitchType, cell.stance, cell.balls, cell.strikes]),
      load,
    });
  }
  rows.sort(
    (a, b) =>
      order(a.game, b.game) ||
      order(a.stratum, b.stratum) ||
      a.pitchBucket - b.pitchBucket ||
      (a.meeting ?? 0) - (b.meeting ?? 0),
  );
  const definitions: {
    dimension: WorkloadComparisonDimension;
    reference: string;
    groups: string[];
  }[] = [
    { dimension: "rest", reference: "2+", groups: ["0", "1"] },
    { dimension: "previous3Days", reference: "0–29", groups: ["30–59", "60+"] },
    { dimension: "previous7Days", reference: "0–29", groups: ["30–59", "60+"] },
    { dimension: "pitchNumber", reference: "1–25", groups: ["26–50", "51–75", "76+"] },
    { dimension: "meeting", reference: "1", groups: ["2", "3"] },
  ];
  return {
    query,
    scope,
    pitcherId,
    sourceHash,
    definitionVersion: 1,
    coverage: "collected_records_only",
    lookbackCompetition: "all",
    policy: WORKLOAD_COMPARISON_POLICY,
    actualPitches,
    roleEvidence,
    excludedConditionPitches,
    dimensions: definitions.map(({ dimension, reference, groups }) => {
      const eligible = rows.filter((row) => group(row, dimension) !== null);
      const groupedPitches = eligible.reduce((sum, row) => sum + row.pitches, 0);
      return {
        dimension,
        groupedPitches,
        excludedWorkloadPitches: actualPitches - excludedConditionPitches - groupedPitches,
        comparisons: groups.flatMap((comparison) =>
          (["speed", "swing", "whiff"] as const).map((metric) =>
            contrast(eligible, dimension, reference, comparison, metric),
          ),
        ),
      };
    }),
  };
}
