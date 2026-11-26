import { analysisQueryMeta } from "./analysis-query-meta";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  analysisPeriodQueries,
  type AnalysisPeriodQuery,
  type AnalysisScopeQuery,
  type StatisticsPeriodQuery,
  type PitchOutcomeQuery,
  type DisciplineQuery,
} from "@kbo/contracts";
import {
  getAnalysisPeriodComparison,
  type PeriodComparisonKind,
} from "../api/analysis-period-client";
import { AnalysisQueryError } from "./analysis-query-error";
import { PeriodComparisonFrame, periodComparisonKey } from "./period-comparison-frame";
import { PeriodComparisonResults } from "./period-comparison-results";

export function PlayerPeriodComparison({
  kind,
  query,
  playerId,
  role,
  alwaysOpen = false,
}: {
  kind: PeriodComparisonKind;
  query: AnalysisScopeQuery | PitchOutcomeQuery | DisciplineQuery;
  playerId: string;
  role?: "pitcher" | "batter";
  alwaysOpen?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const title =
    kind === "statistics"
      ? "두 기간의 기본 성적 비교"
      : kind === "pitch-shape"
        ? "두 기간의 구질 비교"
        : kind === "batter-profile"
          ? "두 기간의 타자 특성 비교"
          : "두 기간의 선구 지표 비교";
  const { season, dateFrom, dateTo, ...conditions } = query;
  void season;
  void dateFrom;
  void dateTo;
  return (
    <PeriodComparisonFrame
      key={JSON.stringify([playerId, role, periodComparisonKey(query, params)])}
      query={query}
      params={params}
      onChange={setParams}
      title={title}
      alwaysOpen={alwaysOpen}
      description={
        kind === "statistics"
          ? "같은 선수·경기 종류의 공식 타석·투구 기록을 비교합니다."
          : kind === "pitch-shape"
            ? "같은 선수·경기 종류의 전체 구종 프로필을 비교합니다. 산점도의 구종·클러스터 표시 선택은 적용하지 않습니다."
            : "두 기간에 같은 선수·경기 종류와 현재의 상황 조건을 적용합니다."
      }
    >
      {(periods) => (
        <PeriodComparisonData
          key={JSON.stringify([kind, playerId, conditions, periods, role])}
          kind={kind}
          query={{
            ...conditions,
            ...periods,
            ...(kind === "statistics" ? { role: role ?? "pitcher" } : {}),
          }}
          playerId={playerId}
        />
      )}
    </PeriodComparisonFrame>
  );
}
function PeriodComparisonData({
  kind,
  query,
  playerId,
}: {
  kind: PeriodComparisonKind;
  query: AnalysisPeriodQuery | StatisticsPeriodQuery;
  playerId: string;
}) {
  const result = useQuery({
    queryKey: ["analysis-period-comparison", kind, playerId, query],
    meta: analysisQueryMeta(query),
    staleTime: 60_000,
    queryFn: ({ signal }) => getAnalysisPeriodComparison(kind, query, playerId, signal),
  });
  const periods = analysisPeriodQueries(query);
  const href = (q: typeof periods.first) => {
    const { role, ...scope } =
      "role" in q
        ? q
        : { ...q, role: kind === "statistics" || kind === "pitch-shape" ? "pitcher" : "batter" };
    const search = new URLSearchParams(Object.entries(scope).map(([k, v]) => [k, String(v)]));
    search.set(role === "pitcher" ? "pitcher" : "batter", playerId);
    if (kind === "statistics") {
      search.set("playerRole", String(role));
      if (scope.dateFrom === undefined && scope.dateTo === undefined) {
        search.set("dateFrom", `${scope.season}-01-01`);
        search.set("dateTo", `${scope.season}-12-31`);
      }
    }
    return `/analysis/${kind === "statistics" ? "player-statistics" : kind}?${search}`;
  };
  return (
    <>
      <AnalysisQueryError queries={[result]} />
      {result.isFetching && <p role="status">두 기간의 기록을 읽고 있습니다.</p>}
      {!result.isFetching && !result.error && result.data && (
        <>
          <PeriodComparisonResults
            key={JSON.stringify([result.data.first.sourceHash, result.data.second.sourceHash])}
            data={result.data}
            defaultMetric={
              kind === "pitch-shape"
                ? "평균 구속"
                : kind === "statistics"
                  ? "role" in query && query.role === "batter"
                    ? "OPS"
                    : "K−BB%"
                  : "Whiff%"
            }
          />
          <div className="period-evidence-links">
            <Link to={href(periods.first)}>기간 A 근거 보기</Link>
            <Link to={href(periods.second)}>기간 B 근거 보기</Link>
          </div>
        </>
      )}
    </>
  );
}
