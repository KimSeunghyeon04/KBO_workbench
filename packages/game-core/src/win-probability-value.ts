import type {
  AnalysisPlay,
  RunTrainingGame,
  WinModel,
  WinProbability,
  WinProbabilityResponse,
} from "@kbo/contracts";
import { winState, supportedWinEnding } from "./win-probability-input.js";
import { winInningLimit } from "./win-probability-rules.js";
import { winPredictor } from "./win-probability.js";
export function evaluateWinValues(
  game: RunTrainingGame,
  plays: readonly AnalysisPlay[],
  model: WinModel | null,
  modelHash: string | null,
): WinProbabilityResponse {
  const limit = winInningLimit(game.season),
    ordered = [...plays].filter((p) => p.applied).sort((a, b) => a.sequence - b.sequence),
    last = ordered.at(-1),
    normal =
      game.normalEnd &&
      game.status === "final" &&
      game.scheduledInnings === 9 &&
      last !== undefined &&
      (limit === null || supportedWinEnding(last.after, limit)),
    terminal: WinProbability | null = !normal
      ? null
      : last.after.homeScore > last.after.awayScore
        ? { homeWin: 1, draw: 0, homeLoss: 0, value: 1 }
        : last.after.homeScore === last.after.awayScore
          ? { homeWin: 0, draw: 1, homeLoss: 0, value: 0.5 }
          : { homeWin: 0, draw: 0, homeLoss: 1, value: 0 };
  const status: WinProbabilityResponse["status"] = !normal
    ? "incomplete_game"
    : limit === null
      ? "unsupported_rules"
      : model?.status !== "ready"
        ? "model_unavailable"
        : !model.limits.includes(limit)
          ? "unsupported_rules"
          : game.season !== model.trainedThrough + 1
            ? "outside_training_period"
            : "ready";
  const predict = model === null ? null : winPredictor(model);
  let terminalIndex = ordered.length - 1;
  if (last !== undefined && limit !== null)
    while (terminalIndex > 0) {
      const previous = ordered[terminalIndex - 1];
      if (
        previous === undefined ||
        JSON.stringify(winState(previous.after, limit)) !==
          JSON.stringify(winState(last.after, limit))
      )
        break;
      terminalIndex--;
    }
  const points = ordered.map((p, i) => {
    const beforeState = limit === null ? null : winState(p.before, limit),
      afterState = limit === null ? null : winState(p.after, limit),
      before =
        i > terminalIndex
          ? terminal
          : status === "ready" && beforeState !== null
            ? (predict?.(beforeState) ?? null)
            : null,
      after =
        i >= terminalIndex
          ? terminal
          : status === "ready" && afterState !== null
            ? (predict?.(afterState) ?? null)
            : null,
      homeWpa = before === null || after === null ? null : after.value - before.value;
    return {
      playId: p.playId,
      sequence: p.sequence,
      inning: p.inning,
      half: p.half,
      kind: p.kind,
      terminal: i >= terminalIndex,
      before,
      after,
      homeWpa,
      awayWpa: homeWpa === null ? null : -homeWpa,
    };
  });
  const first = points[0],
    startValue = first?.after?.value ?? null,
    wpaSum =
      status === "ready" && startValue !== null && points.slice(1).every((p) => p.homeWpa !== null)
        ? points.slice(1).reduce((s, p) => s + (p.homeWpa ?? 0), 0)
        : null;
  return {
    gameId: game.gameId,
    revision: game.revision,
    documentHash: game.documentHash,
    modelHash,
    model,
    status,
    startValue,
    terminalValue: terminal?.value ?? null,
    wpaSum,
    conserved:
      wpaSum === null || startValue === null || terminal === null
        ? null
        : Math.abs(wpaSum - (terminal.value - startValue)) < 1e-8,
    plays: points,
  };
}
