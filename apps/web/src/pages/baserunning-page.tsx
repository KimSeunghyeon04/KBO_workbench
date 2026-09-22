import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnalysisScopeFields, scopeFromParams } from "../analysis/analysis-scope-fields";
import { getBaserunning } from "../api/baserunning-client";
import "../styles/pitch-analysis.css";
const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const labels = {
  extra_base: "추가 진루",
  no_extra_base: "추가 진루 없음",
  out: "아웃",
  unknown: "해석 불가",
  excluded_complex: "복합 이동 제외",
};
export function BaserunningPage() {
  const [params, setParams] = useSearchParams(),
    selected = new URLSearchParams(params),
    season = Number(params.get("season") ?? 2025);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected),
    query = { season, ...scope.options },
    playerId = params.get("player"),
    requestedPage = Number(params.get("playerPage") ?? 0),
    playerPage = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0,
    [page, setPage] = useState(0);
  const result = useQuery({
    queryKey: ["baserunning", query, playerId],
    enabled: scope.error === null,
    queryFn: ({ signal }) => getBaserunning(query, playerId, signal),
  });
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "season") {
      next.delete("dateFrom");
      next.delete("dateTo");
    }
    if (key !== "playerPage" && key !== "player") next.delete("playerPage");
    setPage(0);
    setParams(next);
  }
  const data = result.data;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>주루와 추가 진루</h1>
          <p>확인된 기록의 집계입니다. 주력이나 판단 능력의 종합 점수는 아닙니다.</p>
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
      {(result.error || scope.error) && <p role="alert">{String(result.error ?? scope.error)}</p>}
      {result.isFetching && <p role="status">주루 기록을 읽고 있습니다.</p>}
      {data && (
        <>
          {[
            {
              title: "선수별 주루",
              rows: data.players.slice(playerPage * 50, playerPage * 50 + 50),
              paged: true,
            },
            { title: "팀별 주루", rows: data.teams, paged: false },
          ].map((group) => (
            <section className="panel" key={group.title}>
              <h2>{group.title}</h2>
              <p>
                SB/(SB+CS). 견제사는 CS와 별도로 유지합니다. 경기 수는 해당 선수·팀의 주루 기록이
                있는 경기 수입니다.
              </p>
              <div className="table-scroll" tabIndex={0}>
                <table aria-label={group.title}>
                  <thead>
                    <tr>
                      {[
                        "선수/팀",
                        "당시 팀",
                        "경기",
                        "진루",
                        "추가 베이스",
                        "득점",
                        "SB",
                        "CS",
                        "견제사",
                        "도루 성공률",
                      ].map((v) => (
                        <th key={v}>{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((r) => (
                      <tr key={`${r.identity}-${r.teamId}`}>
                        <th>
                          {r.playerId === null ? (
                            r.name
                          ) : (
                            <button onClick={() => change("player", r.playerId ?? "")}>
                              {r.name}
                            </button>
                          )}
                        </th>
                        <td>{r.teamName}</td>
                        <td>{r.games}</td>
                        <td>{r.advances}</td>
                        <td>{r.extraBases}</td>
                        <td>{r.runs}</td>
                        <td>{r.stolenBases}</td>
                        <td>{r.caughtStealing}</td>
                        <td>{r.pickoffs}</td>
                        <td>{percent(r.stealRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {group.paged && (
                <>
                  <button
                    disabled={playerPage === 0}
                    onClick={() => change("playerPage", String(playerPage - 1))}
                  >
                    이전 선수
                  </button>
                  <span>
                    {" "}
                    {playerPage + 1} / {Math.max(1, Math.ceil(data.players.length / 50))}{" "}
                  </span>
                  <button
                    disabled={(playerPage + 1) * 50 >= data.players.length}
                    onClick={() => change("playerPage", String(playerPage + 1))}
                  >
                    다음 선수
                  </button>
                </>
              )}
            </section>
          ))}
          <section className="panel">
            <h2>선택 선수의 단타 추가 진루 기회</h2>
            {playerId === null ? (
              <p>선수 이름을 선택하면 단타 시작 시 1·2루 주자의 기회를 확인합니다.</p>
            ) : (
              <>
                <p>
                  선수 ID {playerId} · 후보 {data.opportunitySummary.candidates} · 적격{" "}
                  {data.opportunitySummary.eligible} · 성공 {data.opportunitySummary.extraBase} ·
                  추가 진루 없음 {data.opportunitySummary.noExtraBase} · 아웃{" "}
                  {data.opportunitySummary.out} · 해석 불가 {data.opportunitySummary.unknown} · 복합
                  제외 {data.opportunitySummary.excludedComplex} · 성공률{" "}
                  {percent(data.opportunitySummary.extraBaseRate)}
                </p>
                <p>
                  1루→3루 이상, 2루→홈을 성공으로 셉니다. 잔류도 분모에 포함하며 같은 플레이의
                  다단계 이동은 한 기회입니다. 인정 득점이 불명확하면 비율을 확정하지 않습니다.
                </p>
                <div className="table-scroll" tabIndex={0}>
                  <table aria-label="추가 진루 근거">
                    <thead>
                      <tr>
                        {["경기", "시작", "결과", "최종 베이스", "제외/미상 사유"].map((v) => (
                          <th key={v}>{v}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.opportunities.slice(page * 30, page * 30 + 30).map((r) => (
                        <tr key={JSON.stringify([r.gameId, r.revision, r.playId, r.runnerId])}>
                          <td>
                            <Link
                              to={`/replay?${new URLSearchParams({ gameId: r.gameId, revision: String(r.revision) })}`}
                            >
                              {r.gameDate} · {r.playId} · r{r.revision}
                            </Link>
                          </td>
                          <td>{r.fromBase}루</td>
                          <td>{labels[r.outcome]}</td>
                          <td>{r.finalBase ?? "—"}</td>
                          <td>{r.reason ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                  이전
                </button>
                <button
                  disabled={(page + 1) * 30 >= data.opportunities.length}
                  onClick={() => setPage(page + 1)}
                >
                  다음
                </button>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
