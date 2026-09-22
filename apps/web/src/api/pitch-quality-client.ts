import { Value } from "@sinclair/typebox/value";
import {
  PitchQualityResponseSchema,
  resolveAnalysisScope,
  canonicalStringify,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getPitchQuality(
  pitcherId: string,
  query: AnalysisScopeQuery,
  signal: AbortSignal,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const data = Value.Decode(
    PitchQualityResponseSchema,
    await requestJson(`/api/v2/analysis/pitch-quality/${encodeURIComponent(pitcherId)}?${search}`, {
      signal,
    }),
  );
  const c = data.coverage;
  if (
    data.pitcherId !== pitcherId ||
    canonicalStringify(data.scope) !== canonicalStringify(resolveAnalysisScope(query, "regular")) ||
    c.actual !==
      c.ineligible +
        c.missing +
        c.calibrationUnsupported +
        c.outOfSupport +
        c.modelUnavailable +
        c.used ||
    data.groups.reduce((s, g) => s + g.pitches, 0) !== c.actual
  )
    throw new Error("구종 기대 효과의 범위 또는 표본 합계가 맞지 않습니다.");
  return data;
}
