import { useQuery } from "@tanstack/react-query";
import {
  resolveAnalysisScope,
  type DisciplineQuery,
  type DisciplineResponse,
} from "@kbo/contracts";
import { getBatterDiscipline } from "../api/batter-discipline-client";
const percent = (x: number | null) => (x === null ? "—" : `${(100 * x).toFixed(1)}%`);
export function DisciplinePeriodComparison({
  data,
  params,
  onChange,
  onRefresh,
}: {
  data: DisciplineResponse;
  params: URLSearchParams;
  onChange: (key: string, value: string) => void;
  onRefresh: () => void;
}) {
  const from = params.get("compareFrom"),
    to = params.get("compareTo");
  const query: DisciplineQuery = {
    ...data.query,
    ...(from === null ? {} : { dateFrom: from }),
    ...(to === null ? {} : { dateTo: to }),
  };
  let error: string | null = null;
  try {
    resolveAnalysisScope({
      season: query.season,
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
    });
  } catch (value) {
    error = value instanceof Error ? value.message : "잘못된 비교 기간";
  }
  const enabled = from !== null && to !== null && error === null;
  const comparison = useQuery({
    queryKey: ["batter-discipline", data.batterId, query],
    enabled,
    queryFn: ({ signal }) => getBatterDiscipline(query, data.batterId, signal),
  });
  const sameSource = comparison.data?.sourceHash === data.sourceHash;
  return (
    <section className="panel">
      <h2>다른 기간과 비교</h2>
      <p>
        시즌·경기 종류·카운트·구종·타석 조건을 유지합니다. 각 기간의 표본 수와 비교군 수를 함께
        확인하세요.
      </p>
      <label>
        비교 시작일
        <input
          aria-label="선구안 비교 시작일"
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange("compareFrom", e.target.value)}
        />
      </label>
      <label>
        비교 종료일
        <input
          aria-label="선구안 비교 종료일"
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange("compareTo", e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {enabled && comparison.isPending && <p role="status">비교 기간을 계산하고 있습니다.</p>}
      {comparison.error && <p role="alert">{comparison.error.message}</p>}
      {enabled && comparison.data && !sameSource && (
        <p role="alert">
          조회 사이 기록이 갱신됐습니다.{" "}
          <button
            onClick={() => {
              onRefresh();
              void comparison.refetch();
            }}
          >
            두 기간 새로고침
          </button>
        </p>
      )}
      {enabled && comparison.data && sameSource && (
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="선구안 기간 비교">
            <thead>
              <tr>
                {[
                  "기간",
                  "실제 투구",
                  "상황 제외",
                  "존 판정 표본",
                  "지도 표본",
                  "포심 공통 표본",
                  "리그 지도 표본",
                  "Zone%",
                  "Swing%",
                  "Z-Swing%",
                  "Chase%",
                  "헛스윙/스윙",
                  "조건 일치 표본",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[data, comparison.data].map((d, index) => {
                const c = d.courseComparison.conventional.batter;
                return (
                  <tr key={index}>
                    <th>
                      {index === 0 ? "대상" : "비교"}: {d.query.dateFrom ?? "시즌 시작"} ~{" "}
                      {d.query.dateTo ?? "시즌 끝"}
                    </th>
                    <td>{d.coverage.actualPitches}</td>
                    <td>{d.coverage.excludedSituations}</td>
                    <td>{c.pitches}</td>
                    <td>{d.coverage.locationPitches}</td>
                    <td>{d.coverage.comparisonPitches}</td>
                    <td>{d.coverage.leagueLocationPitches}</td>
                    <td>{percent(c.zoneRate)}</td>
                    <td>{percent(c.swingRate)}</td>
                    <td>{percent(c.zoneSwingRate)}</td>
                    <td>{percent(c.chaseRate)}</td>
                    <td>
                      {d.summary.reduce((n, g) => n + g.whiffs, 0)}/
                      {d.summary.reduce((n, g) => n + g.swings, 0)}
                    </td>
                    <td>{d.summary.reduce((n, g) => n + g.matchedPitches, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
