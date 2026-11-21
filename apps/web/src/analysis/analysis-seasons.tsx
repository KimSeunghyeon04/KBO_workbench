import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { Link, useMatch, useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { AnalysisSeasonsSchema, type AnalysisPreparation } from "@kbo/contracts";
import { requestJson } from "../api/transport";

export function useAnalysisSeasons(enabled = true) {
  return useQuery({
    queryKey: ["analysis-seasons"],
    queryFn: async ({ signal }) =>
      Value.Decode(
        AnalysisSeasonsSchema,
        await requestJson("/api/v2/analysis/seasons", { signal }),
      ),
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled,
  });
}
function analysisSeason(requested: string | null, latest: number | undefined) {
  return requested === null ? latest : Number(requested);
}
export function useAnalysisSeason(requested: string | null) {
  const seasons = useAnalysisSeasons(requested === null);
  const season = analysisSeason(requested, seasons.data?.seasons[0]);
  if (season === undefined) throw new Error("분석 화면을 열기 전에 시즌을 확정해야 합니다.");
  return season;
}
export function AnalysisSeasonOptions({
  season,
  minimum = 1982,
}: {
  season: number;
  minimum?: number;
}) {
  const result = useAnalysisSeasons();
  const years = [...new Set([...(result.data?.seasons ?? []), season])]
    .filter((year) => Number.isInteger(year) && year >= minimum && year <= 2200)
    .sort((a, b) => b - a);
  return (
    <>
      {years.map((year) => (
        <option key={year} value={year}>
          {year}
        </option>
      ))}
    </>
  );
}
export function AnalysisRefreshBoundary({ children }: PropsWithChildren) {
  const result = useAnalysisSeasons();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const replay = useMatch("/replay") !== null;
  const requested = params.get("season");
  const needsLatest = !replay && requested === null;
  // Revalidate a stale list on entry. Later background refreshes keep the open page mounted.
  const captureEntry = () => ({
    needsLatest,
    unconfirmedAt: needsLatest && result.isStale ? result.dataUpdatedAt : 0,
  });
  const [entry, setEntry] = useState(captureEntry);
  if (entry.needsLatest !== needsLatest) setEntry(captureEntry());
  const { refetch } = result;
  useEffect(() => {
    if (entry.unconfirmedAt > 0) void refetch({ cancelRefetch: false });
  }, [entry, refetch]);
  const preparationRows = result.data?.preparation;
  const previous = useRef<Map<number, AnalysisPreparation> | undefined>(undefined);
  useEffect(() => {
    if (preparationRows === undefined) return;
    const next = new Map(preparationRows.map((row) => [row.season, row]));
    const prior = previous.current;
    previous.current = next;
    if (prior === undefined) return;

    const sourcesChanged = new Set([...prior.keys()].filter((season) => !next.has(season)));
    const modelsSettled = new Set<number>();
    for (const row of preparationRows) {
      const before = prior.get(row.season);
      if (before?.sourceHash !== row.sourceHash || before.competitionHash !== row.competitionHash) {
        sourcesChanged.add(row.season);
      }
      // An older season can trigger model training for this application season.
      // Training can publish some models even when preparation reports a failure.
      if (
        (row.state === "ready" || row.state === "failed") &&
        (before?.state !== row.state || before.updatedAt !== row.updatedAt)
      ) {
        modelsSettled.add(row.season);
      }
    }
    if (sourcesChanged.size === 0 && modelsSettled.size === 0) return;
    const matchesChangedSeason = (query: Query) => {
      const scope = query.meta?.analysis;
      return (
        scope?.seasons.some(
          (season) => sourcesChanged.has(season) || (scope.usesModels && modelsSettled.has(season)),
        ) ?? false
      );
    };
    // Invalidation alone reuses an in-flight first fetch when there is no cached data.
    void client
      .cancelQueries({
        predicate: (query) =>
          query.isActive() &&
          query.state.data === undefined &&
          query.state.fetchStatus !== "idle" &&
          matchesChangedSeason(query),
      })
      .then(() =>
        client.invalidateQueries({
          predicate: (query) =>
            (query.state.data !== undefined || query.isActive()) && matchesChangedSeason(query),
        }),
      );
  }, [preparationRows, client]);
  if (replay) return children;
  const seasonsConfirmed = result.data !== undefined && result.dataUpdatedAt > entry.unconfirmedAt;
  const season = seasonsConfirmed ? analysisSeason(requested, result.data.seasons[0]) : undefined;
  if (season === undefined && result.error === null) {
    return seasonsConfirmed ? (
      <section className="panel analysis-empty-state" role="status">
        <h2>적재된 시즌이 없습니다</h2>
        <Link className="text-link" to="/database">
          데이터베이스로 이동
        </Link>
      </section>
    ) : (
      <p className="panel loading-panel" role="status">
        적재 시즌을 확인하고 있습니다.
      </p>
    );
  }
  const preparation = result.data?.preparation.find((row) => row.season === season);
  return (
    <>
      {result.error ? (
        <p role="alert">
          적재 시즌과 자동 반영 상태를 확인하지 못했습니다. {result.error.message}{" "}
          <button type="button" onClick={() => void result.refetch()} disabled={result.isFetching}>
            다시 확인
          </button>
        </p>
      ) : (
        preparation !== undefined &&
        (preparation.state !== "ready" || preparation.unclassified !== 0) && (
          <p className="panel" role={preparation.state === "failed" ? "alert" : "status"}>
            {season}시즌{" "}
            {preparation.state === "ready"
              ? `공식 일정과 연결되지 않은 ${preparation.unclassified}경기는 미분류로 유지했습니다. 확인된 경기는 분석에 반영했습니다.`
              : preparation.state === "failed"
                ? `분석 반영 확인 필요: ${preparation.error}`
                : preparation.state === "pending"
                  ? "적재 완료 · 공식 경기 분류와 분석 반영을 기다리고 있습니다."
                  : preparation.state === "classifying"
                    ? "공식 경기 분류를 반영하고 있습니다."
                    : "경기 분류 반영 완료 · 분석 모델을 갱신하고 있습니다. 기본 기록은 바로 조회할 수 있습니다."}
          </p>
        )
      )}
      {season !== undefined && children}
    </>
  );
}
