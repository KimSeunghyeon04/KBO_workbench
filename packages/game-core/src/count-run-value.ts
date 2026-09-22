import type {
  AnalysisPlay,
  AnalysisState,
  CountRunModel,
  CountRunValueResponse,
  RunTrainingGame,
} from "@kbo/contracts";
import { baseMask, completeAnalysisHalf, groupAnalysisHalves } from "./run-expectancy.js";
import { hasTerminalPitch } from "./pitch-outcomes.js";
export const countStateIndex = (s: Pick<AnalysisState, "outs" | "bases" | "balls" | "strikes">) =>
  (s.outs * 8 + baseMask(s)) * 12 + s.balls * 3 + s.strikes;
export const attackScore = (state: AnalysisState, half: AnalysisPlay["half"]) =>
  half === "top" ? state.awayScore : state.homeScore;
export function validCountState(state: AnalysisState) {
  return state.outs < 3 && state.balls < 4 && state.strikes < 3;
}
export function countValueTransitions(half: readonly AnalysisPlay[]) {
  const result: {
    plays: AnalysisPlay[];
    before: AnalysisState;
    after: AnalysisState;
    pitch: boolean;
    terminalLinked: boolean;
    unsupportedLink: boolean;
  }[] = [];
  for (let i = 0; i < half.length; i++) {
    const play = half[i];
    if (play === undefined) continue;
    let end = i,
      terminalLinked = false;
    const pitch = play.pitch;
    if (play.applied && pitch !== null && pitch.call !== "no_pitch") {
      let next = i + 1;
      // These are compiler-provided atomic states; annotations may not hide a state change.
      while (
        (half[next]?.kind === "review" || half[next]?.kind === "administrative") &&
        JSON.stringify(half[next]?.before) === JSON.stringify(half[next]?.after)
      )
        next++;
      const plate = half[next];
      if (
        plate?.applied &&
        plate.kind === "plate_result" &&
        play.after.paId !== null &&
        plate.before.paId === play.after.paId &&
        plate.before.batterId === play.after.batterId &&
        plate.before.pitcherId === play.after.pitcherId &&
        hasTerminalPitch({
          completed: true,
          pitchId: pitch.id,
          result: plate.result,
          afterBalls: play.after.balls,
          afterStrikes: play.after.strikes,
          pitchCall: pitch.call,
          inPlay: pitch.inPlay,
        })
      ) {
        end = next;
        terminalLinked = true;
      }
    }
    const members = half.slice(i, end + 1),
      last = members.at(-1);
    if (last === undefined) throw new Error("Empty analysis transition");
    result.push({
      plays: members,
      before: play.before,
      after: last.after,
      pitch: pitch?.actual === true,
      terminalLinked,
      unsupportedLink:
        (play.kind === "pitch" && pitch === null) ||
        (pitch !== null &&
          !terminalLinked &&
          (pitch.inPlay ||
            pitch.call === "hit_by_pitch" ||
            play.after.balls > 3 ||
            play.after.strikes > 2)),
    });
    i = end;
  }
  return result;
}
export function evaluateCountRunValues(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
  model: CountRunModel | null,
  modelHash: string | null,
): CountRunValueResponse {
  const available = model?.status === "ready" && game.season === model.trainedThrough + 1;
  const value = (state: AnalysisState) =>
    state.outs === 3
      ? 0
      : available && validCountState(state)
        ? (model.cells[countStateIndex(state)]?.mean ?? null)
        : null;
  const halves: CountRunValueResponse["halves"] = [],
    transitions: CountRunValueResponse["transitions"] = [];
  for (const half of groupAnalysisHalves(plays)) {
    const first = half[0],
      last = half.filter((p) => p.applied).at(-1);
    if (first === undefined || last === undefined) continue;
    const complete = completeAnalysisHalf(half),
      startRE = value(first.after),
      runs = attackScore(last.after, first.half) - attackScore(first.after, first.half);
    const rows = countValueTransitions(half).map(
      (t): CountRunValueResponse["transitions"][number] => {
        const lead = t.plays[0];
        if (lead === undefined) throw new Error("Empty transition");
        const beforeRE = value(t.before),
          afterRE = value(t.after),
          delta =
            lead.kind === "half_inning_start"
              ? 0
              : attackScore(t.after, lead.half) - attackScore(t.before, lead.half);
        const status = !lead.applied
          ? "not_applied"
          : lead.kind === "half_inning_start"
            ? "boundary"
            : !complete
              ? "incomplete_half"
              : t.unsupportedLink
                ? "unsupported_link"
                : beforeRE === null || afterRE === null
                  ? "unsupported_state"
                  : "supported";
        return {
          playIds: t.plays.map((p) => p.playId),
          inning: lead.inning,
          half: lead.half,
          kind: t.pitch ? "pitch" : "non_pitch",
          terminalLinked: t.terminalLinked,
          runs: delta,
          beforeRE,
          afterRE,
          value:
            status === "supported" && beforeRE !== null && afterRE !== null
              ? delta + afterRE - beforeRE
              : null,
          status,
        };
      },
    );
    const supported =
        startRE !== null &&
        complete &&
        rows.every(
          (r) => r.status === "supported" || r.status === "boundary" || r.status === "not_applied",
        ),
      pitchValue = supported
        ? rows.filter((r) => r.kind === "pitch").reduce((s, r) => s + (r.value ?? 0), 0)
        : null,
      nonPitchValue = supported
        ? rows.filter((r) => r.kind === "non_pitch").reduce((s, r) => s + (r.value ?? 0), 0)
        : null,
      valueSum = pitchValue === null || nonPitchValue === null ? null : pitchValue + nonPitchValue;
    halves.push({
      inning: first.inning,
      half: first.half,
      complete,
      referenceOnly: first.inning > 8,
      runs,
      startRE,
      pitchValue,
      nonPitchValue,
      valueSum,
      conserved:
        valueSum === null || startRE === null ? null : Math.abs(valueSum - (runs - startRE)) < 1e-8,
    });
    transitions.push(...rows);
  }
  return {
    gameId: game.gameId,
    revision: game.revision,
    documentHash: game.documentHash,
    modelHash,
    model,
    status:
      model?.status !== "ready"
        ? "model_unavailable"
        : !available
          ? "outside_training_period"
          : "ready",
    halves,
    transitions,
  };
}
