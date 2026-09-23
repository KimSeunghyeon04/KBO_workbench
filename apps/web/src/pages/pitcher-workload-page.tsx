import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { pitcherCatalogQueryOptions } from "../api/analysis-catalog-query-options";
import { getPitcherWorkload } from "../api/pitcher-workload-client";
import { WorkloadComparisonPanel } from "../analysis/workload-comparison-panel";
import "../styles/pitch-analysis.css";
const inheritedLabels = {
  scored_during_spell: "등판 중 인정 득점",
  out: "아웃",
  left_on_base: "이닝 종료 잔루",
  passed_to_next_pitcher: "다음 투수로 승계",
  unknown: "미확인",
};
export function PitcherWorkloadPage() {
  const {
    params,
    selected,
    season,
    scope,
    change: changeScope,
  } = useAnalysisScope({
    seasonSelectionKeys: ["pitcher"],
  });
  const [game, setGame] = useState<string | null>(null);
  const query = { season, ...scope.options };
  const catalog = useQuery({
    ...pitcherCatalogQueryOptions(season, scope.options),
    enabled: scope.error === null,
  });
  const id = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "";
  const result = useQuery({
    queryKey: ["pitcher-workload", id, query],
    enabled: scope.error === null && id !== "",
    queryFn: ({ signal }) => getPitcherWorkload(query, id, signal),
  });
  function change(key: string, value: string) {
    setGame(null);
    changeScope(key, value);
  }
  const data = result.data,
    detail = data?.appearances.find((r) => r.gameId === game) ?? data?.appearances.at(-1);
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>투수 운용</h1>
          <p>수집 기록 기준 누적 투구·대면·승계주자입니다.</p>
        </div>
      </header>
      <PitcherScopeFields
        season={season}
        params={selected}
        pitchers={catalog.data?.pitchers ?? []}
        pitcherId={id}
        onChange={change}
      />
      {(result.error || catalog.error || scope.error) && (
        <p role="alert">{String(result.error ?? catalog.error ?? scope.error)}</p>
      )}
      {(catalog.isLoading || result.isFetching) && <p role="status">등판 기록을 읽고 있습니다.</p>}
      {scope.error === null &&
        !catalog.isFetching &&
        !catalog.error &&
        catalog.data?.pitchers.length === 0 && (
          <AnalysisEmptyState season={season} options={scope.options} />
        )}
      <section className="panel">
        <p>
          3/7일 투구 수는 대상 날짜를 제외한 이전 달력 날짜의 실제 투구 합입니다. 이전 기록은
          시즌·팀·경기 종류를 넘어 읽습니다. 미수집 경기가 있을 수 있어 실제 휴식이나 전체
          누적량으로 확정하지 않습니다. 같은 날 경기 순서는 미확인으로 유지합니다.
        </p>
      </section>
      {scope.error === null && id !== "" && (
        <WorkloadComparisonPanel query={query} pitcherId={id} />
      )}
      {data && (
        <section className="panel">
          <h2>등판 기록</h2>
          <div className="table-scroll" tabIndex={0}>
            <table aria-label="투수 등판 기록">
              <thead>
                <tr>
                  {[
                    "경기",
                    "당시 팀",
                    "등록 선발/구원",
                    "투구",
                    "공식 BF",
                    "직전 관측 등판",
                    "관측 휴식일",
                    "이전 3일",
                    "이전 7일",
                    "연속 관측 날짜",
                    "같은 날 등판",
                    "상세",
                  ].map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.appearances.map((r) => (
                  <tr key={`${r.gameId}-${r.revision}`}>
                    <td>
                      <Link
                        to={`/replay?${new URLSearchParams({ gameId: r.gameId, revision: String(r.revision) })}`}
                      >
                        {r.gameDate} · r{r.revision}
                      </Link>
                    </td>
                    <td>{r.teamName}</td>
                    <td>{r.role === "starter" ? "선발" : r.role === "relief" ? "구원" : "미상"}</td>
                    <td>{r.pitches}</td>
                    <td>{r.battersFaced}</td>
                    <td>{r.previousObservedDate ?? "—"}</td>
                    <td>{r.observedRestDays ?? "—"}</td>
                    <td>{r.previous3DaysPitches}</td>
                    <td>{r.previous7DaysPitches}</td>
                    <td>{r.observedConsecutiveDays}</td>
                    <td>
                      {r.sameDayAppearances}
                      {r.sameDayOrder === "unknown" ? " · 순서 미상" : ""}
                    </td>
                    <td>
                      <button onClick={() => setGame(r.gameId)}>상세</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {detail && (
        <>
          <section className="panel">
            <h2>{detail.gameDate} · 대면과 승계주자</h2>
            <Link
              to={`/analysis/pitcher-changes?${new URLSearchParams({ season: String(season), competition: scope.options.competition ?? "regular", pitcher: id, dateTo: detail.gameDate })}`}
            >
              이 날짜까지 구종 변화 보기
            </Link>
            <p>
              실제 공을 던진 타석 {detail.encounters.length}개 · 공식 BF {detail.battersFaced}. 반복
              대면은 타순 순환과 다른 지표입니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="실제 대면">
                <thead>
                  <tr>
                    <th>타석</th>
                    <th>타자 ID</th>
                    <th>같은 타자 대면 회차</th>
                    <th>실제 투구</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.encounters.map((e) => (
                    <tr key={`${e.paId}-${e.batterId}`}>
                      <td>{e.paId}</td>
                      <td>{e.batterId}</td>
                      <td>{e.meetingNumber}</td>
                      <td>{e.pitches}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              승계는 투수 등장 시 실제로 루에 있던 주자를 추적합니다. 대주자 교체는 별도 이름으로
              보존하며, 야수선택으로 이어진 책임 점수 전체를 이 값으로 대체하지 않습니다.
            </p>
            <ul>
              {detail.inherited.map((r, i) => (
                <li key={`${r.entryPlayId}-${i}`}>
                  {r.runnerId}
                  {r.currentRunnerId !== r.runnerId ? ` → ${r.currentRunnerId}` : ""} · 책임 투수{" "}
                  {r.responsiblePitcherId} · {inheritedLabels[r.outcome]} · 근거 {r.entryPlayId} /{" "}
                  {r.outcomePlayId ?? "—"}
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2>경기 내 투구 수 구간</h2>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="투구 수 구간">
                <thead>
                  <tr>
                    {["구간", "구종", "타석", "공", "구속 확인", "평균 km/h", "스윙", "헛스윙"].map(
                      (v) => (
                        <th key={v}>{v}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {detail.buckets.map((b) => (
                    <tr key={`${b.bucket}-${b.pitchType}-${b.stance}`}>
                      <td>{b.bucket}</td>
                      <td>{b.pitchType ?? "미상"}</td>
                      <td>{b.stance ?? "미상"}</td>
                      <td>{b.pitches}</td>
                      <td>{b.speedCount}</td>
                      <td>{b.meanSpeedKph?.toFixed(1) ?? "—"}</td>
                      <td>{b.swings}</td>
                      <td>{b.whiffs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
