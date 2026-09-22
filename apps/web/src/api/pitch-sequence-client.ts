import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PitchSequenceResponseSchema,
  type PitchSequenceQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getPitchSequences(
  query: PitchSequenceQuery,
  id: string,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const result = Value.Decode(
    PitchSequenceResponseSchema,
    await requestJson(`/api/v2/analysis/pitch-sequences/${encodeURIComponent(id)}?${params}`, {
      signal,
    }),
  );
  const c = result.coverage;
  if (
    result.pitcherId !== id ||
    canonicalStringify(query) !== canonicalStringify(result.query) ||
    c.targetPitches !== c.noPrevious + c.nonActualBoundary + c.playerChange + c.eligiblePairs ||
    c.filteredPairs !== result.pairs.length ||
    result.groups.reduce((n, g) => n + g.pairs, 0) !== c.filteredPairs
  )
    throw new Error("배합 범위 또는 표본이 다릅니다.");
  return result;
}
