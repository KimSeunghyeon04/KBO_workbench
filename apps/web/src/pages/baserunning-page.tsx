import { useQuery } from "@tanstack/react-query";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { AnalysisScopeFields } from "../analysis/analysis-scope-fields";
import { changeAnalysisParams, scopeFromParams } from "../analysis/analysis-scope";
import { getBaserunning } from "../api/baserunning-client";
import { BaserunningOpportunities } from "../analysis/baserunning-opportunities";
import "../styles/pitch-analysis.css";
import "../styles/analysis-evidence.css";
const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
export function BaserunningPage() {
  const [params, setParams] = useSearchParams(),
    selected = new URLSearchParams(params),
    season = Number(params.get("season") ?? 2025);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected),
    query = { season, ...scope.options },
    playerId = params.get("player"),
    requestedPage = Number(params.get("playerPage") ?? 0),
    playerPage = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? requestedPage : 0;
  const selectionHeading = useRef<HTMLHeadingElement>(null);
  const pendingSelection = useRef<string | null>(null);
  const result = useQuery({
    queryKey: ["baserunning", query, playerId],
    enabled: scope.error === null,
    queryFn: ({ signal }) => getBaserunning(query, playerId, signal),
  });
  function change(key: string, value: string) {
    const next = changeAnalysisParams(params, key, value);
    if (key !== "playerPage" && key !== "player") next.delete("playerPage");
    setParams(next);
  }
  const data = result.data;
  useEffect(() => {
    if (pendingSelection.current === null || data?.playerId !== pendingSelection.current) return;
    pendingSelection.current = null;
    selectionHeading.current?.focus({ preventScroll: true });
    selectionHeading.current?.scrollIntoView({ block: "start" });
  }, [data]);
  const runners = [
    ...new Map(
      data?.players.flatMap((row) => (row.playerId === null ? [] : [[row.playerId, row] as const])),
    ).values(),
  ];
  function selectRunner(id: string) {
    pendingSelection.current = id;
    change("player", id);
    if (id === playerId) {
      pendingSelection.current = null;
      selectionHeading.current?.focus({ preventScroll: true });
      selectionHeading.current?.scrollIntoView({ block: "start" });
    }
  }
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
      {scope.error && <p role="alert">{scope.error}</p>}
      <AnalysisQueryError queries={[result]} enabled={scope.error === null} />
      {result.isFetching && <p role="status">주루 기록을 읽고 있습니다.</p>}
      <section
        className="panel baserunning-selection"
        aria-labelledby="baserunning-selection-heading"
      >
        <h2 id="baserunning-selection-heading" ref={selectionHeading} tabIndex={-1}>
          선수의 추가 진루
        </h2>
        <label>
          주자
          <select
            value={playerId ?? ""}
            onChange={(event) => change("player", event.target.value)}
            disabled={result.isFetching}
          >
            <option value="">선수를 선택하세요</option>
            {playerId !== null && !runners.some((row) => row.playerId === playerId) && (
              <option value={playerId}>선수 ID {playerId}</option>
            )}
            {runners.map((row) => (
              <option key={row.playerId} value={row.playerId ?? ""}>
                {row.name} · {row.playerId}
              </option>
            ))}
          </select>
        </label>
        {playerId === null ? (
          <p>주자를 선택하면 단타 때의 추가 진루 결과와 경기 장면을 확인합니다.</p>
        ) : (
          data && <BaserunningOpportunities key={JSON.stringify([query, playerId])} data={data} />
        )}
      </section>
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
              <p className="analysis-caption">
                기존 주자가 베이스에서 출발한 이동만 집계합니다. 진루 횟수는 성공한 이동 행 수, 초과
                이동 베이스는 성공한 이동마다 한 베이스를 넘게 간 수의 합입니다. 타자 자신의 홈런
                득점은 제외하므로 기존 주자 득점은 기본 기록의 총득점과 다릅니다.
              </p>
              <div className="table-scroll" tabIndex={0}>
                <table aria-label={group.title}>
                  <thead>
                    <tr>
                      {[
                        "선수/팀",
                        "당시 팀",
                        "경기",
                        "기존 주자 진루 횟수",
                        "초과 이동 베이스",
                        "기존 주자 득점",
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
                            <button
                              aria-pressed={r.playerId === playerId}
                              onClick={() => selectRunner(r.playerId ?? "")}
                            >
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
        </>
      )}
    </div>
  );
}
