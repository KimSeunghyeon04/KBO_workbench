import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { AnalysisSeasonsSchema } from "@kbo/contracts";
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
  return Number(requested ?? latest ?? 2025);
}
export function useAnalysisSeason(requested: string | null) {
  const seasons = useAnalysisSeasons(requested === null);
  return analysisSeason(requested, seasons.data?.seasons[0]);
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
export function AnalysisRefreshBoundary() {
  const { pathname } = useLocation();
  return pathname.startsWith("/analysis") || pathname === "/replay" ? (
    <AnalysisDataRefresh showStatus={pathname.startsWith("/analysis")} />
  ) : null;
}
function AnalysisDataRefresh({ showStatus }: { showStatus: boolean }) {
  const result = useAnalysisSeasons();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    const hash = result.data?.sourceHash;
    if (hash === undefined) return;
    const changed = previous.current !== hash;
    previous.current = hash;
    if (changed)
      void client.invalidateQueries({
        predicate: (query) =>
          query.state.data !== undefined &&
          query.queryKey[0] !== "analysis-seasons" &&
          /^(analysis|pitch|batter|baserunning|park|matchup|statistics|run-value|count-run|win-probability|workload-comparison|player-statistics)/.test(
            String(query.queryKey[0]),
          ),
      });
  }, [result.data?.sourceHash, client]);
  if (!showStatus) return null;
  const season = analysisSeason(params.get("season"), result.data?.seasons[0]);
  const preparation = result.data?.preparation.find((row) => row.season === season);
  if (result.error)
    return (
      <p role="alert">
        적재 시즌과 자동 반영 상태를 확인하지 못했습니다. {result.error.message}{" "}
        <button type="button" onClick={() => void result.refetch()} disabled={result.isFetching}>
          다시 확인
        </button>
      </p>
    );
  if (
    preparation === undefined ||
    (preparation.state === "ready" && preparation.unclassified === 0)
  )
    return null;
  return (
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
  );
}
