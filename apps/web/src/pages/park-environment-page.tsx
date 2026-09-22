import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { AnalysisScopeFields, scopeFromParams } from "../analysis/analysis-scope-fields";
import { getParkEnvironment } from "../api/park-environment-client";
import "../styles/pitch-analysis.css";
const n = (v: number | null) => v?.toFixed(3) ?? "—";
export function ParkEnvironmentPage() {
  const [params, setParams] = useSearchParams(),
    selected = new URLSearchParams(params),
    season = Number(params.get("season") ?? 2025),
    [page, setPage] = useState(0);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected),
    query = { season, ...scope.options },
    result = useQuery({
      queryKey: ["park-environment", query],
      enabled: scope.error === null,
      queryFn: ({ signal }) => getParkEnvironment(query, signal),
    }),
    data = result.data;
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "season") {
      next.delete("dateFrom");
      next.delete("dateTo");
    }
    setPage(0);
    setParams(next);
  }
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>구장 득점 환경</h1>
          <p>
            구장별 관측 성적과 검증된 조정값을 구분합니다. 투구 움직임의 측정 편향 보정과는 별도
            분석입니다.
          </p>
        </div>
      </header>
      <section className="panel pitch-analysis-toolbar">
        <label>
          시즌
          <select value={season} onChange={(e) => change("season", e.target.value)}>
            {[2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
        <AnalysisScopeFields params={selected} onChange={change} />
      </section>
      {(scope.error || result.error) && <p role="alert">{String(scope.error ?? result.error)}</p>}
      {result.isFetching && <p role="status">구장별 성적을 집계합니다.</p>}
      {data && (
        <>
          <section className="panel">
            <h2>관측 성적 · {data.games}경기</h2>
            <p>
              확인하지 못한 구장 {data.unknownParkGames}경기. 대전의 2025년 새 시설은 이전 시설과
              분리합니다. 득점/타석은 경기 전체, 완결 반이닝당 득점은 정상 9이닝 경기의 1–8회 3아웃
              완료 반이닝만 사용합니다. 단순 평균에는 선수 구성 차이가 포함됩니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="구장별 홈 원정 성적">
                <thead>
                  <tr>
                    {[
                      "구장·시설",
                      "공격",
                      "경기",
                      "PA",
                      "득점",
                      "HR",
                      "득점/PA",
                      "HR/PA",
                      "완결 반이닝",
                      "득점/완결 반이닝",
                      "제외 반이닝",
                    ].map((s) => (
                      <th key={s}>{s}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.parks.flatMap((p) =>
                    [
                      { label: "전체", value: p.total },
                      { label: "홈", value: p.home },
                      { label: "원정", value: p.away },
                    ].map((g) => (
                      <tr key={`${p.key}-${g.label}`}>
                        <th>
                          {p.stadiums.join(" / ") || "구장 미상"}
                          <small> {p.parkId ?? "시설 미확인"}</small>
                        </th>
                        <td>{g.label}</td>
                        <td>{g.value.games}</td>
                        <td>{g.value.pa}</td>
                        <td>{g.value.runs}</td>
                        <td>{g.value.homeRuns}</td>
                        <td>{n(g.value.runRate)}</td>
                        <td>{n(g.value.homeRunRate)}</td>
                        <td>{g.value.completeHalves}</td>
                        <td>{n(g.value.completeRunRate)}</td>
                        <td>{g.value.excludedHalves}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>팀 구성 조정</h2>
            {data.modelStatus !== "ready" && (
              <p>
                {data.modelStatus === "scope_mismatch"
                  ? "조정값은 확인된 정규시즌 전체 범위에서만 표시합니다."
                  : data.modelStatus === "not_adopted"
                    ? "시간 검증에서 구장 없는 기준보다 개선한 조정 모델이 없어 채택하지 않았습니다."
                    : "현재 원천에 맞는 학습 모델이 없습니다. 관측 성적을 제공합니다."}
              </p>
            )}
            {data.model && data.modelStatus !== "scope_mismatch" && (
              <>
                <p>
                  {data.model.trainedThrough}시즌까지 학습. 공격팀·상대팀·시즌·월·홈/원정 항을
                  포함합니다. 상대 지수는 학습 구장의 기하평균 100이며, 95% 구간은 경기 단위 상관을
                  반영한 근사 구간입니다. 새 시설의 효과는 기존 시설에서 승계하지 않습니다.
                </p>
                {data.model.metrics.map((m) => (
                  <div key={m.metric}>
                    <h3>{m.metric === "home_runs" ? "홈런 / PA" : "득점 / 완결 반이닝"}</h3>
                    <p>
                      {m.adopted ? "채택" : "미채택"} · {m.fitted.family} · 학습{" "}
                      {m.fitted.trainingGames}경기 · 과산포 지표 {n(m.fitted.dispersion)}
                    </p>
                    <div className="table-scroll" tabIndex={0}>
                      <table aria-label={`${m.metric} 조정값`}>
                        <thead>
                          <tr>
                            {["시설", "경기", "노출량", "지수", "95% 구간", "상태"].map((s) => (
                              <th key={s}>{s}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {m.fitted.factors.map((f) => (
                            <tr key={f.parkId}>
                              <th>{f.parkId}</th>
                              <td>{f.games}</td>
                              <td>{f.exposure}</td>
                              <td>{n(f.index)}</td>
                              <td>
                                {n(f.low95)} – {n(f.high95)}
                              </td>
                              <td>
                                {f.status === "supported"
                                  ? "지원"
                                  : f.status === "insufficient_data"
                                    ? "표본 부족"
                                    : f.status === "unidentified"
                                      ? "식별 불가"
                                      : "미채택"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <details>
                      <summary>시간 검증</summary>
                      <div className="table-scroll" tabIndex={0}>
                        <table aria-label={`${m.metric} 시간 검증`}>
                          <thead>
                            <tr>
                              {[
                                "구장 항",
                                "분포",
                                "λ",
                                "시즌",
                                "팀·경기",
                                "제외",
                                "Deviance",
                                "MAE",
                              ].map((s) => (
                                <th key={s}>{s}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {m.validation.flatMap((v) =>
                              v.evaluations.map((e) => (
                                <tr key={`${v.withPark}-${v.family}-${v.lambda}-${e.season}`}>
                                  <td>{v.withPark ? "포함" : "기준"}</td>
                                  <td>{v.family}</td>
                                  <td>{v.lambda}</td>
                                  <td>{e.season}</td>
                                  <td>{e.rows}</td>
                                  <td>{e.excluded}</td>
                                  <td>{n(e.deviance)}</td>
                                  <td>{n(e.mae)}</td>
                                </tr>
                              )),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </div>
                ))}
              </>
            )}
          </section>
          <section className="panel">
            <h2>근거 경기</h2>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="구장 분석 근거">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>구장</th>
                    <th>경기</th>
                  </tr>
                </thead>
                <tbody>
                  {data.evidence.slice(page * 50, page * 50 + 50).map((g) => (
                    <tr key={g.gameId}>
                      <td>{g.gameDate}</td>
                      <td>{g.stadium ?? "미상"}</td>
                      <td>
                        <Link
                          to={`/replay?gameId=${encodeURIComponent(g.gameId)}&revision=${g.revision}`}
                        >
                          {g.gameId} r{g.revision}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              이전 경기
            </button>
            <button
              disabled={(page + 1) * 50 >= data.evidence.length}
              onClick={() => setPage(page + 1)}
            >
              다음 경기
            </button>
          </section>
        </>
      )}
    </div>
  );
}
