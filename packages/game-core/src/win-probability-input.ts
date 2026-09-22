import type {
  AnalysisPlay,
  AnalysisState,
  RunTrainingGame,
  WinObservation,
  WinState,
} from "@kbo/contracts";
import { baseMask } from "./run-expectancy.js";
import { winInningLimit } from "./win-probability-rules.js";
export function winState(state: AnalysisState, limit: 11 | 12): WinState | null {
  return state.inning < 1 || state.inning > limit
    ? null
    : {
        inning: state.inning,
        half: state.half,
        outs: state.outs,
        bases: baseMask(state),
        lead: state.homeScore - state.awayScore,
        limit,
      };
}
export function supportedWinEnding(state: AnalysisState, limit: 11 | 12) {
  if (state.inning < 9 || state.inning > limit) return false;
  if (state.homeScore === state.awayScore)
    return state.inning === limit && state.half === "bottom" && state.outs === 3;
  if (state.homeScore < state.awayScore) return state.half === "bottom" && state.outs === 3;
  return state.half === "bottom" || (state.half === "top" && state.outs === 3);
}
export function collectWinObservations(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
  targetLimit: 11 | 12 | null = winInningLimit(game.season),
): WinObservation[] {
  const sourceLimit = winInningLimit(game.season),
    ordered = [...plays].filter((p) => p.applied).sort((a, b) => a.sequence - b.sequence),
    last = ordered.at(-1);
  if (
    sourceLimit === null ||
    targetLimit === null ||
    targetLimit > sourceLimit ||
    !game.normalEnd ||
    game.scheduledInnings !== 9 ||
    game.status !== "final" ||
    last === undefined ||
    !supportedWinEnding(last.after, sourceLimit)
  )
    return [];

  // Shortening changes only the analysis outcome. Require the observed third out at
  // the new limit; never infer that boundary from a later inning or extend a game.
  let terminalIndex = ordered.length - 1;
  if (last.after.inning > targetLimit) {
    terminalIndex = -1;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const state = ordered[i]?.after;
      if (state?.inning === targetLimit && state.half === "bottom" && state.outs === 3) {
        terminalIndex = i;
        break;
      }
    }
  }
  const terminal = ordered[terminalIndex];
  if (
    terminal === undefined ||
    !supportedWinEnding(terminal.after, targetLimit) ||
    (terminalIndex < ordered.length - 1 && terminal.after.homeScore !== terminal.after.awayScore)
  )
    return [];
  const outcome =
      terminal.after.homeScore > terminal.after.awayScore
        ? 0
        : terminal.after.homeScore === terminal.after.awayScore
          ? 1
          : 2,
    states = new Map<string, WinState>();
  for (const p of ordered.slice(0, terminalIndex + 1)) {
    if (p.kind === "half_inning_start") {
      const state = winState(p.after, targetLimit);
      if (state !== null) states.set(JSON.stringify(state), state);
    } else {
      const state = winState(p.before, targetLimit);
      if (state !== null) states.set(JSON.stringify(state), state);
    }
  }
  // Identical count-insensitive states occur many times. One game still contributes total weight 1.
  states.delete(JSON.stringify(winState(terminal.after, targetLimit)));
  return [...states.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, state]) => ({
      ...state,
      gameId: game.gameId,
      revision: game.revision,
      season: game.season,
      outcome,
      weight: 1 / states.size,
    }));
}
