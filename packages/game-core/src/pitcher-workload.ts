import type {
  WorkloadAppearance,
  WorkloadEncounter,
  WorkloadPitchBucket,
  PitcherWorkloadResponse,
  AnalysisPlay,
  AnalysisScopeQuery,
  AnalysisScope,
} from "@kbo/contracts";
import { workloadCalendar } from "./workload-calendar.js";
type Inherited = PitcherWorkloadResponse["appearances"][number]["inherited"][number];
const key = (r: { gameId: string; revision: number }) => JSON.stringify([r.gameId, r.revision]);
function inheritedRunners(
  plays: AnalysisPlay[],
  pitcherId: string,
  side: WorkloadAppearance["side"],
): Inherited[] {
  const field = side === "home" ? "homePitcherId" : "awayPitcherId",
    result: Inherited[] = [],
    active: Inherited[] = [];
  for (const p of plays) {
    if (!p.applied) continue;
    if (
      p.before[field] !== pitcherId &&
      p.after[field] === pitcherId &&
      p.before.halfActive &&
      p.before.half === (side === "home" ? "top" : "bottom")
    ) {
      for (const r of p.before.bases) {
        if (r === null) continue;
        const inherited: Inherited = {
          entryPlayId: p.playId,
          runnerId: r.runnerId,
          currentRunnerId: r.runnerId,
          responsiblePitcherId: r.pitcherId,
          outcome: "unknown",
          outcomePlayId: null,
        };
        result.push(inherited);
        active.push(inherited);
      }
    }
    if (p.before[field] !== pitcherId) continue;
    for (const r of [...active]) {
      if (p.kind === "substitution")
        for (let i = 0; i < 3; i++) {
          const a = p.before.bases[i],
            b = p.after.bases[i];
          if (
            a?.runnerId === r.currentRunnerId &&
            b !== null &&
            b !== undefined &&
            b.pitcherId === a.pitcherId
          )
            r.currentRunnerId = b.runnerId;
        }
      const movements = p.movements.filter((m) => m.runnerId === r.currentRunnerId),
        last = movements.at(-1);
      const runs =
        p.half === "top"
          ? p.after.awayScore - p.before.awayScore
          : p.after.homeScore - p.before.homeScore;
      let done = false;
      if (last?.outcome === "scored") {
        r.outcome =
          p.movements.filter((m) => m.outcome === "scored").length === runs
            ? "scored_during_spell"
            : "unknown";
        done = true;
      } else if (last?.outcome === "out") {
        r.outcome = "out";
        done = true;
      } else if (p.after.outs === 3) {
        r.outcome = "left_on_base";
        done = true;
      } else if (p.after[field] !== pitcherId) {
        r.outcome = "passed_to_next_pitcher";
        done = true;
      }
      if (done) {
        r.outcomePlayId = p.playId;
        active.splice(active.indexOf(r), 1);
      }
    }
  }
  return result;
}
/** Calendar totals exclude the target day. Missing collected games never become evidence of rest. */
export function analyzePitcherWorkload(
  query: AnalysisScopeQuery,
  pitcherId: string,
  scope: AnalysisScope,
  sourceHash: string,
  history: readonly WorkloadAppearance[],
  selectedGameIds: ReadonlySet<string>,
  encounters: readonly WorkloadEncounter[],
  plays: readonly AnalysisPlay[],
  buckets: readonly WorkloadPitchBucket[],
): PitcherWorkloadResponse {
  const cutoff = scope.dateTo ?? `${scope.season}-12-31`,
    ordered = history
      .filter((r) => r.gameDate <= cutoff)
      .sort((a, b) =>
        a.gameDate === b.gameDate
          ? a.gameId < b.gameId
            ? -1
            : 1
          : a.gameDate < b.gameDate
            ? -1
            : 1,
      );
  const calendar = workloadCalendar(ordered, cutoff);
  const groupedPlays = new Map<string, AnalysisPlay[]>(),
    groupedEncounters = new Map<string, WorkloadEncounter[]>(),
    groupedBuckets = new Map<string, WorkloadPitchBucket[]>();
  for (const p of plays) {
    const k = key(p),
      v = groupedPlays.get(k) ?? [];
    v.push(p);
    groupedPlays.set(k, v);
  }
  for (const e of encounters) {
    const k = key(e),
      v = groupedEncounters.get(k) ?? [];
    v.push(e);
    groupedEncounters.set(k, v);
  }
  for (const b of buckets) {
    const k = key(b),
      v = groupedBuckets.get(k) ?? [];
    v.push(b);
    groupedBuckets.set(k, v);
  }
  const appearances = ordered
    .filter((r) => selectedGameIds.has(r.gameId))
    .map((r) => {
      const date = calendar.get(r.gameDate);
      if (date === undefined) throw new Error("Missing workload date");
      const counts = new Map<string, number>();
      const meeting = (groupedEncounters.get(key(r)) ?? [])
        .sort((a, b) => a.firstSequence - b.firstSequence)
        .map((e) => {
          const meetingNumber = (counts.get(e.batterId) ?? 0) + 1;
          counts.set(e.batterId, meetingNumber);
          return { ...e, meetingNumber };
        });
      return {
        ...r,
        ...date,
        observedConsecutiveDays: r.pitches > 0 ? date.observedConsecutiveDays : 0,
        sameDayEarlierPitches: null,
        sameDayOrder: date.sameDayAppearances > 1 ? ("unknown" as const) : ("single" as const),
        encounters: meeting,
        inherited: inheritedRunners(
          (groupedPlays.get(key(r)) ?? []).sort((a, b) => a.sequence - b.sequence),
          pitcherId,
          r.side,
        ),
        buckets: groupedBuckets.get(key(r)) ?? [],
      };
    });
  return {
    query,
    scope,
    sourceHash,
    pitcherId,
    coverage: "collected_records_only",
    lookbackCompetition: "all",
    appearances,
  };
}
