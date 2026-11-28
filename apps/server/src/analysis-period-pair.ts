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
): PeriodSnapshot {
  const { season, competition, dateFrom, dateTo } = query;
  return {
    sourceHash,
    samples,
    scope: resolveAnalysisScope({
      season,
      ...(competition === undefined ? {} : { competition }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    }),
  };
}

/** Recheck the first source after both results are ready, outside their read snapshots. */
export async function readAnalysisPeriodPair<T extends { sourceHash: string }>(
  read: () => Promise<{ first: T; second: T }>,
  readFirstSourceHash: () => Promise<string>,
): Promise<{ first: T; second: T }> {
  const pair = await read();
  assertPeriodSourceHash(pair.first.sourceHash, await readFirstSourceHash());
  return pair;
}

export function assertPeriodSourceHash(sourceHash: string, currentSourceHash: string): void {
  if (sourceHash !== currentSourceHash)
    throw new InvalidAnalysisScopeError(
      "비교 조회 중 원천 기록이 갱신됐습니다. 두 기간 비교를 다시 시도하세요.",
    );
}
