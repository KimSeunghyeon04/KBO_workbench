import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { PitchAnglesPanel } from "../analysis/pitch-angles-panel";
import { useQuery } from "@tanstack/react-query";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { Link } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { PitcherChangesQuerySchema } from "@kbo/contracts";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { pitcherCatalogQueryOptions } from "../api/analysis-catalog-query-options";
import { getPitcherChanges } from "../api/pitcher-changes-client";
import { PitcherChangeSummary } from "../analysis/pitcher-change-summary";
import {
  formatPitchChange,
  pitchChangeInterval,
  pitchChangeMetrics,
} from "../analysis/pitch-change-metrics";
import "../styles/pitch-analysis.css";
const n = (v: number | null) => v?.toFixed(2) ?? "—";
export function PitcherChangesPage() {
  const { params, selected, season, scope, change } = useAnalysisScope({
    throughSeasonEnd: true,
  });
  const query = { season, ...scope.options, dateTo: selected.get("dateTo") ?? "" };
  const valid = scope.error === null && Value.Check(PitcherChangesQuerySchema, query);
  const catalog = useQuery({
    ...pitcherCatalogQueryOptions(season, scope.options),
    enabled: valid,
  });
  const id = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "";
  const result = useQuery({
    queryKey: ["pitcher-changes", id, query],
    enabled: valid && id !== "",
    queryFn: ({ signal }) => getPitcherChanges(query, id, signal),
  });
  const data = result.data;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>투수 변화</h1>
          <p>종료일까지 완료된 등판의 최근 3경기와 이전 5경기를 비교합니다.</p>
        </div>
      </header>
      <PitcherScopeFields
        season={season}
        params={selected}
        pitchers={catalog.data?.pitchers ?? []}
        pitcherId={id}
        catalogLoaded={catalog.isSuccess}
        onChange={change}
      />
      {!valid && <p role="alert">{scope.error ?? "종료일을 확인해 주세요."}</p>}
      <AnalysisQueryError queries={[result, catalog]} enabled={valid} />
      {result.isFetching && <p role="status">종료일 기준 자료를 계산하고 있습니다.</p>}
      {catalog.data?.pitchers.length === 0 && <p>이 범위에 수집된 투수가 없습니다.</p>}
      {data && (
        <>
          <PitcherChangeSummary data={data} />
          <details className="panel analysis-disclosure">
            <summary>비교 방법과 표본 구성</summary>
            <p>
              {data.status === "ambiguous_same_day"
                ? "같은 날 등판 순서를 확인할 수 없어 비교 창을 나누지 않았습니다."
                : data.status === "insufficient_games"
                  ? "8등판 미만입니다. 확보한 창과 표본만 표시합니다."
                  : "서로 겹치지 않는 3/5등판 비교입니다."}{" "}
              기준 자료의 마지막 경기: {data.baselineLastDate ?? "없음"}.
            </p>
            <p>
              차이는 투구 가중 평균입니다. 보정 좌표는 보정 적용 표본만 사용합니다. 각 창 30구·3경기
              미만이면 신뢰구간을 표시하지 않습니다. 95% 구간은 경기 단위 재표집{" "}
              {data.bootstrapReplicates}회이며, 구장·카운트 구성이 달라진 영향까지 포함한 관측
              차이입니다.
            </p>
            {[
              { label: "최근 3등판", value: data.recent },
              { label: "이전 5등판", value: data.previous },
            ].map((w) => (
              <section key={w.label}>
                <h3>{w.label}</h3>
                <p>
                  {w.value.pitches}구 · 보정 적용 {w.value.calibrated}구
                </p>
                <p>
                  구장: {w.value.parks.map((g) => `${g.key} ${g.pitches}구`).join(" / ") || "—"}
                </p>
                <p>
                  타석: {w.value.stances.map((g) => `${g.key} ${g.pitches}구`).join(" / ") || "—"}
                </p>
                <p>
                  카운트: {w.value.counts.map((g) => `${g.key} ${g.pitches}구`).join(" / ") || "—"}
                </p>
                <ul>
                  {w.value.games.map((g) => (
                    <li key={g.gameId}>
                      <Link
                        to={`/replay?${new URLSearchParams({ gameId: g.gameId, revision: String(g.revision) })}`}
                      >
                        {g.gameDate} · {g.stadium ?? "구장 미상"} · {g.pitches}구
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </details>
          <details className="panel analysis-disclosure">
            <summary>전체 구종·지표별 변화</summary>
            <p>
              차이와 95% 구간은 최근−이전입니다. 사용률은 %, 사용률 차이는 %p로 표시합니다. 사용률의
              분모는 각 기간 전체 투구이며 표본 열은 해당 구종 투구 수입니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="구종별 변화">
                <thead>
                  <tr>
                    {[
                      "구종",
                      "지표",
                      "최근",
                      "이전",
                      "차이",
                      "95% 구간",
                      "표본 최근/이전",
                      "경기 최근/이전",
                      "경기 동일 가중 최근/이전",
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.changes.flatMap((g) =>
                    g.metrics.map((m) => (
                      <tr key={`${g.pitchType}-${m.metric}`}>
                        <th>{g.pitchType ?? "미상"}</th>
                        <td>{pitchChangeMetrics[m.metric].label}</td>
                        <td>{formatPitchChange(m.metric, m.recent)}</td>
                        <td>{formatPitchChange(m.metric, m.previous)}</td>
                        <td>{formatPitchChange(m.metric, m.difference, true)}</td>
                        <td>{pitchChangeInterval(m)}</td>
                        <td>
                          {m.recentCount}/{m.previousCount}
                        </td>
                        <td>
                          {m.recentGames}/{m.previousGames}
                        </td>
                        <td>
                          {formatPitchChange(m.metric, m.recentGameMean)}/
                          {formatPitchChange(m.metric, m.previousGameMean)}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </details>
          <details className="panel analysis-disclosure">
            <summary>전체 등판별 구종 · {data.games.length}경기</summary>
            <p>
              사용률의 분모는 해당 등판의 전체 투구 수입니다. 구속은 km/h, 위치와 표준편차는
              cm입니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="등판별 구종">
                <thead>
                  <tr>
                    {[
                      "경기",
                      "구종",
                      "공",
                      "사용률",
                      "구속 km/h",
                      "보정 수",
                      "보정 가로 / 세로 cm",
                      "표준편차 가로 / 세로 cm",
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.games.flatMap((g) =>
                    g.groups.map((p) => (
                      <tr key={`${g.gameId}-${p.pitchType}`}>
                        <td>
                          <Link
                            to={`/replay?${new URLSearchParams({ gameId: g.gameId, revision: String(g.revision) })}`}
                          >
                            {g.gameDate} · {g.gameId}
                          </Link>
                        </td>
                        <td>{p.pitchType ?? "미상"}</td>
                        <td>{p.actualPitches}</td>
                        <td>{formatPitchChange("usage", p.usageRate)}</td>
                        <td>{n(p.meanSpeedKph)}</td>
                        <td>{p.calibratedCount}</td>
                        <td>
                          {n(p.calibratedXCm)} / {n(p.calibratedZCm)}
                        </td>
                        <td>
                          {n(p.sdXCm)} / {n(p.sdZCm)}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </details>
          <PitchAnglesPanel pitcherId={id} query={query} />
        </>
      )}
    </div>
  );
}
