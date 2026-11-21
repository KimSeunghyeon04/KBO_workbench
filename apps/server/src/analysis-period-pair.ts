import {
  InvalidAnalysisScopeError,
  resolveAnalysisScope,
  type AnalysisScopeQuery,
  type PeriodSnapshot,
} from "@kbo/contracts";

export function periodSnapshot(
  query: AnalysisScopeQuery,
  sourceHash: string,
  samples: PeriodSnapshot["samples"],
  competition: "all" | "regular" = "all",
): PeriodSnapshot {
  const { season, dateFrom, dateTo } = query;
  return {
    sourceHash,
    samples,
    scope: resolveAnalysisScope({
      season,
      competition: query.competition ?? competition,
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    }),
  };
}

/** Each reader releases its snapshot before computation. Recheck A after B rather
 * than holding a database connection through calibration or worker execution.
 * Source hashes cover all inputs, including references. A changed seal is rejected.
 */
export async function readAnalysisPeriodPair<T extends { sourceHash: string }>(
  first: () => Promise<T>,
  second: () => Promise<T>,
  readFirstSourceHash = async () => (await first()).sourceHash,
): Promise<{ first: T; second: T }> {
  const a = await first();
  const b = await second();
  if (a.sourceHash !== (await readFirstSourceHash()))
    throw new InvalidAnalysisScopeError(
      "비교 조회 중 원천 기록이 갱신됐습니다. 두 기간 비교를 다시 시도하세요.",
    );
  return { first: a, second: b };
}
