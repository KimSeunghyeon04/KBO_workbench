import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { scopeFromParams } from "../analysis/analysis-scope-fields";
import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { getPitchAnalysisCatalog } from "../api/pitch-analysis-client";
import { getDisciplineCatalog } from "../api/batter-discipline-client";
import { getMatchup } from "../api/matchup-client";
import { MatchupModelPanel } from "../analysis/matchup-model-panel";
import "../styles/pitch-analysis.css";
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
export function MatchupPage() {
  const [params, setParams] = useSearchParams(),
    selected = new URLSearchParams(params),
    season = Number(params.get("season") ?? 2025),
    [sample, setSample] = useState<"direct" | "similar">("direct"),
    [page, setPage] = useState(0);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected),
    catalog = useQuery({
      queryKey: ["matchup-pitchers", season, scope.options],
      enabled: scope.error === null,
      queryFn: ({ signal }) => getPitchAnalysisCatalog(season, signal, scope.options),
    }),
    batters = useQuery({
      queryKey: ["matchup-batters", season, scope.options],
      enabled: scope.error === null,
      queryFn: ({ signal }) => getDisciplineCatalog(season, signal, scope.options),
    });
  const pitcherId = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "",
    batterId = params.get("batter") ?? batters.data?.batters[0]?.batterId ?? "",
    query = { season, ...scope.options, pitcherId, batterId };
  const result = useQuery({
    queryKey: ["matchup", query],
    enabled: scope.error === null && pitcherId !== "" && batterId !== "",
    queryFn: ({ signal }) => getMatchup(query, signal),
  });
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "season") {
      for (const k of ["dateFrom", "dateTo", "pitcher", "batter"]) next.delete(k);
    }
    setPage(0);
    setParams(next);
  }
  const data = result.data;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>투타 매치업</h1>
          <p>직접 상대 기록과 같은 조건의 공에 대한 타자 반응입니다.</p>
        </div>
      </header>
      <PitcherScopeFields
        season={season}
        params={selected}
        pitchers={catalog.data?.pitchers ?? []}
        pitcherId={pitcherId}
        onChange={change}
      >
        <label>
          타자
          <select value={batterId} onChange={(e) => change("batter", e.target.value)}>
            {batters.data?.batters.map((b) => (
              <option key={b.batterId} value={b.batterId}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </PitcherScopeFields>
      {(result.error || catalog.error || batters.error || scope.error) && (
        <p role="alert">{String(result.error ?? catalog.error ?? batters.error ?? scope.error)}</p>
      )}
      {result.isFetching && <p role="status">매치업을 읽고 있습니다.</p>}
      {scope.error === null && pitcherId !== "" && batterId !== "" && (
        <MatchupModelPanel query={query} />
      )}
      {data && (
        <>
          <section className="panel">
            <p>
              직접 표본은 실제 맞대결 투구 전체입니다. 유사 표본은 선택 투수가 던진 공과 원
              구종·카운트·타석 좌우·5 km/h 구간이 같은 이 타자의 공입니다. HBP·IBB·번트를 제외하며
              구속·구종·타석이 미상 또는 구속이 0–500 km/h 범위 밖이면 조건을 만들지 않습니다. 유사
              조건에서 제외된 타자 투구 {data.excludedSimilar}구.
            </p>
            <p>
              두 표본은 겹칠 수 있어 합산하지 않습니다. 아래 조건 비교는 관측 통계입니다. 타자별
              기대 확률은 별도의 구질 유사도·기대 반응 패널에서 검증 상태와 함께 확인합니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="매치업 관측 반응">
                <thead>
                  <tr>
                    {[
                      "표본",
                      "공",
                      "경기",
                      "상대 투수",
                      "스윙",
                      "헛스윙",
                      "Swing%",
                      "Whiff%",
                      "루킹%",
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: "직접 상대", value: data.direct },
                    { label: "유사 조건", value: data.similar },
                  ].map((c) => (
                    <tr key={c.label}>
                      <th>{c.label}</th>
                      <td>{c.value.pitches}</td>
                      <td>{c.value.games}</td>
                      <td>{c.value.pitchers}</td>
                      <td>{c.value.swings}</td>
                      <td>{c.value.whiffs}</td>
                      <td>{percent(c.value.swingRate)}</td>
                      <td>{percent(c.value.whiffRate)}</td>
                      <td>{percent(c.value.calledStrikeRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              공식 타석 책임 기준 직접 상대 PA {data.directPlateAppearances.length}개. 타석 중 선수
              교체가 있으면 실제 맞대결 투구의 타석 수와 다를 수 있습니다.
            </p>
            <ul>
              {data.directPlateAppearances.map((p) => (
                <li key={`${p.gameId}-${p.paId}`}>
                  <Link
                    to={`/replay?${new URLSearchParams({ gameId: p.gameId, revision: String(p.revision) })}`}
                  >
                    {p.gameDate} · {p.paId} · {p.result} · r{p.revision}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2>같은 조건의 다른 타자와 비교</h2>
            <p>
              조건별 다른 타자 20구 이상에서 스윙·루킹, 다른 타자 20스윙 이상에서 헛스윙을
              비교합니다. 같은 지원 표본의 조건 구성으로 리그 비율을 가중합니다.
            </p>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="매치업 조건 일치 비교">
                <thead>
                  <tr>
                    <th>지표</th>
                    <th>비교 표본</th>
                    <th>선택 타자</th>
                    <th>조건 일치 리그</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Swing%</th>
                    <td>{data.matched.pitches}구</td>
                    <td>{percent(data.matched.observedSwingRate)}</td>
                    <td>{percent(data.matched.leagueSwingRate)}</td>
                  </tr>
                  <tr>
                    <th>Whiff%</th>
                    <td>{data.matched.swings}스윙</td>
                    <td>{percent(data.matched.observedWhiffRate)}</td>
                    <td>{percent(data.matched.leagueWhiffRate)}</td>
                  </tr>
                  <tr>
                    <th>루킹%</th>
                    <td>{data.matched.pitches}구</td>
                    <td>{percent(data.matched.observedCalledStrikeRate)}</td>
                    <td>{percent(data.matched.leagueCalledStrikeRate)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <h2>투구 근거</h2>
            <label>
              표본
              <select
                value={sample}
                onChange={(e) => {
                  setSample(e.target.value === "similar" ? "similar" : "direct");
                  setPage(0);
                }}
              >
                <option value="direct">직접 상대</option>
                <option value="similar">유사 조건</option>
              </select>
            </label>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="매치업 투구 근거">
                <thead>
                  <tr>
                    {["경기", "투수 ID", "투구", "구종", "구속", "카운트", "좌우", "결과"].map(
                      (v) => (
                        <th key={v}>{v}</th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data[sample].rows.slice(page * 25, page * 25 + 25).map((p) => (
                    <tr key={JSON.stringify([p.gameId, p.revision, p.pitchId])}>
                      <td>
                        <Link
                          to={`/replay?${new URLSearchParams({ gameId: p.gameId, revision: String(p.revision) })}`}
                        >
                          {p.gameDate} r{p.revision}
                        </Link>
                      </td>
                      <td>{p.pitcherId ?? "미상"}</td>
                      <td>{p.pitchId}</td>
                      <td>{p.pitchType ?? "미상"}</td>
                      <td>{p.speedKph ?? "—"}</td>
                      <td>
                        {p.balls}-{p.strikes}
                      </td>
                      <td>{p.stance ?? "미상"}</td>
                      <td>
                        {p.whiff
                          ? "헛스윙"
                          : p.swing
                            ? "컨택"
                            : p.calledStrike
                              ? "루킹"
                              : "볼/기타"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              이전
            </button>
            <button
              disabled={(page + 1) * 25 >= data[sample].rows.length}
              onClick={() => setPage(page + 1)}
            >
              다음
            </button>
          </section>
        </>
      )}
    </div>
  );
}
