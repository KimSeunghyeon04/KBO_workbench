import { useQuery } from "@tanstack/react-query";
import type { PitchOutcomeQuery, PitchLocationComparisonQuery } from "@kbo/contracts";
import { getPitchLocationComparison } from "../api/pitch-location-comparison-client";
import { AnalysisQueryError } from "./analysis-query-error";
import { PitchLocationComparisonMaps } from "./pitch-location-comparison-maps";
import { PeriodComparisonFrame, periodComparisonKey } from "./period-comparison-frame";

export function PitchLocationPeriodComparison({
  query,
  id,
  params,
  onChange,
}: {
  query: PitchOutcomeQuery;
  id: string;
  params: URLSearchParams;
  onChange: (params: URLSearchParams) => void;
}) {
  const { season, dateFrom, dateTo, ...conditions } = query;
  void season;
  void dateFrom;
  void dateTo;
  return (
    <PeriodComparisonFrame
      key={JSON.stringify([id, periodComparisonKey(query, params)])}
      query={query}
      params={params}
      onChange={onChange}
      title="두 기간의 코스 비교"
      alwaysOpen
      description="두 기간에 같은 경기 종류·구종·카운트·타석·표본 조건을 적용합니다."
    >
      {(periods) => (
        <LocationComparisonData
          key={JSON.stringify([id, conditions, periods])}
          id={id}
          query={{ ...conditions, ...periods }}
        />
      )}
    </PeriodComparisonFrame>
  );
}
function LocationComparisonData({
  query,
  id,
}: {
  query: PitchLocationComparisonQuery;
  id: string;
}) {
  const result = useQuery({
    queryKey: ["pitch-location-comparison", id, query],
    staleTime: 60_000,
    queryFn: ({ signal }) => getPitchLocationComparison(query, id, signal),
  });
  return (
    <>
      <AnalysisQueryError queries={[result]} />
      {result.isFetching && <p role="status">두 기간의 코스를 읽고 있습니다.</p>}
      {!result.isFetching && !result.error && result.data && (
        <PitchLocationComparisonMaps data={result.data} />
      )}
    </>
  );
}
