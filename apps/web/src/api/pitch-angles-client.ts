import { Value } from "@sinclair/typebox/value";
import {
  PitchAnglesResponseSchema,
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeQuery,
} from "@kbo/contracts";
import { requestJson } from "./transport";
export async function getPitchAngles(
  pitcherId: string,
  query: AnalysisScopeQuery,
  signal: AbortSignal,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const result = Value.Decode(
      PitchAnglesResponseSchema,
      await requestJson(
        `/api/v2/analysis/pitch-angles/${encodeURIComponent(pitcherId)}?${search}`,
        { signal },
      ),
    ),
    c = result.coverage;
  if (
    result.pitcherId !== pitcherId ||
    canonicalStringify(result.scope) !==
      canonicalStringify(resolveAnalysisScope(query, "regular")) ||
    c.actual !== c.missingTracking + c.unsupported + c.invalid + c.used ||
    result.points.length !== c.used ||
    result.groups.reduce((n, g) => n + g.pitches, 0) !== c.used ||
    result.games.reduce((n, g) => n + g.groups.reduce((total, p) => total + p.pitches, 0), 0) !==
      c.used
  )
    throw new Error("진입각 분석의 범위 또는 표본 합계가 맞지 않습니다.");
  return result;
}
