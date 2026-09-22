import { Value } from "@sinclair/typebox/value";
import {
  RunValueResponseSchema,
  CountRunValueResponseSchema,
  WinProbabilityResponseSchema,
  type ReplayManifest,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getRunValues(manifest: ReplayManifest, signal: AbortSignal) {
  const result = Value.Decode(
    RunValueResponseSchema,
    await requestJson(
      `/api/v2/analysis/run-value/games/${encodeURIComponent(manifest.gameId)}?${new URLSearchParams({ revision: String(manifest.revision), season: manifest.gameDate.slice(0, 4) })}`,
      { signal },
    ),
  );
  if (
    result.gameId !== manifest.gameId ||
    result.revision !== manifest.revision ||
    result.documentHash !== manifest.documentHash
  )
    throw new Error("득점가치의 경기 원천이 재생과 다릅니다.");
  return result;
}
export async function getWinProbabilities(manifest: ReplayManifest, signal: AbortSignal) {
  const result = Value.Decode(
    WinProbabilityResponseSchema,
    await requestJson(
      `/api/v2/analysis/win-probability/games/${encodeURIComponent(manifest.gameId)}?${new URLSearchParams({ revision: String(manifest.revision), season: manifest.gameDate.slice(0, 4) })}`,
      { signal },
    ),
  );
  if (
    result.gameId !== manifest.gameId ||
    result.revision !== manifest.revision ||
    result.documentHash !== manifest.documentHash
  )
    throw new Error("승리확률의 원천이 재생과 다릅니다.");
  for (const point of result.plays)
    for (const p of [point.before, point.after])
      if (
        p !== null &&
        (Math.abs(p.homeWin + p.draw + p.homeLoss - 1) > 1e-8 ||
          Math.abs(p.value - p.homeWin - 0.5 * p.draw) > 1e-8)
      )
        throw new Error("승리확률 합계가 맞지 않습니다.");
  return result;
}
export async function getCountRunValues(manifest: ReplayManifest, signal: AbortSignal) {
  const result = Value.Decode(
    CountRunValueResponseSchema,
    await requestJson(
      `/api/v2/analysis/count-run-value/games/${encodeURIComponent(manifest.gameId)}?${new URLSearchParams({ revision: String(manifest.revision), season: manifest.gameDate.slice(0, 4) })}`,
      { signal },
    ),
  );
  if (
    result.gameId !== manifest.gameId ||
    result.revision !== manifest.revision ||
    result.documentHash !== manifest.documentHash
  )
    throw new Error("투구 득점가치의 원천이 재생과 다릅니다.");
  const ids = result.transitions.flatMap((t) => t.playIds);
  if (new Set(ids).size !== ids.length)
    throw new Error("득점가치 전이가 플레이를 중복 포함합니다.");
  return result;
}
