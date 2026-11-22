import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { AnalysisEvidenceLink } from "../analysis/analysis-evidence-link";
import { useQuery } from "@tanstack/react-query";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { useEffect, useState } from "react";
import { SampleRate } from "../analysis/sample-rate";
import { plateResultLabel } from "../events/relay-text";
import { replayEvidenceUrl } from "../replay/evidence-target";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { analysisCatalogPlayers, selectedPlayerRole } from "../analysis/player-analysis-navigation";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getMatchup } from "../api/matchup-client";
import { MatchupModelPanel } from "../analysis/matchup-model-panel";
import { MatchupObservedSummary } from "../analysis/matchup-observed-summary";
import "../styles/pitch-analysis.css";
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
export function MatchupPage() {
  const { params, selected, season, scope, change: changeScope } = useAnalysisScope();
  const [sample, setSample] = useState<"direct" | "similar">("direct");
  const [page, setPage] = useState(0);
  const catalog = useQuery({
      ...pitcherCatalogQueryOptions(season, scope.options),
      enabled: scope.error === null,
    }),
    batters = useQuery({
      ...batterCatalogQueryOptions(season, scope.options),
      enabled: scope.error === null,
    });
  const pitcherId = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "",
    batterId = params.get("batter") ?? batters.data?.batters[0]?.batterId ?? "",
    query = { season, ...scope.options, pitcherId, batterId };
  const opponentIsPitcher = selectedPlayerRole(params) === "batter";
  const opponentRole = opponentIsPitcher ? "pitcher" : "batter";
  const opponentLabel = opponentIsPitcher ? "상대 투수" : "상대 타자";
  const opponentId = opponentIsPitcher ? pitcherId : batterId;
  const opponentCatalog = opponentIsPitcher ? catalog : batters;
  const opponents = opponentCatalog.data ? analysisCatalogPlayers(opponentCatalog.data) : [];
  const opponentMissing =
    opponentId !== "" && !opponents.some((player) => player.id === opponentId);
  useEffect(() => setPage(0), [season, pitcherId, batterId]);
  const result = useQuery({
    queryKey: ["matchup", query],
    meta: analysisQueryMeta(query),
    enabled: scope.error === null && pitcherId !== "" && batterId !== "",
    queryFn: ({ signal }) => getMatchup(query, signal),
  });
  function change(key: string, value: string) {
    setPage(0);
    changeScope(key, value);
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
        params={selected}
        onChange={change}
        primary={
          <label>
            {opponentLabel}
            <select value={opponentId} onChange={(e) => change(opponentRole, e.target.value)}>
              {opponentMissing && (
                <option value={opponentId}>ID {opponentId} · 해당 범위 기록 없음</option>
              )}
              {opponents.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {opponentCatalog.isSuccess && opponentMissing && (
        <p role="status">
          {opponentLabel}(ID {opponentId})의 실제 투구가 이 조회 범위에 없습니다.
        </p>
      )}
      {scope.error && <p role="alert">{scope.error}</p>}
      <AnalysisQueryError queries={[result, catalog, batters]} enabled={scope.error === null} />
      {(catalog.isLoading || batters.isLoading || result.isFetching) && (
        <p role="status">매치업을 읽고 있습니다.</p>
      )}
      {scope.error === null &&
        !catalog.isFetching &&
        !batters.isFetching &&
        !catalog.error &&
        !batters.error &&
        (catalog.data?.pitchers.length === 0 || batters.data?.batters.length === 0) && (
          <AnalysisEmptyState season={season} options={scope.options} />
        )}
      {data && (
        <>
          <section className="panel">
            <MatchupObservedSummary direct={data.direct} similar={data.similar} />
            <details className="matchup-detail">
              <summary>표본 기준과 분모</summary>
              <p>
                직접 표본은 실제 맞대결 투구 전체입니다. 유사 표본은 선택 투수가 던진 공과 원
                구종·카운트·타석 좌우·5 km/h 구간이 같은 이 타자의 공입니다. HBP·IBB·번트를 제외하며
                구속·구종·타석이 미상 또는 구속이 0–500 km/h 범위 밖이면 조건을 만들지 않습니다.
                유사 조건에서 제외된 타자 투구 {data.excludedSimilar}구.
              </p>
              <p>
                두 표본은 겹칠 수 있어 합산하지 않습니다. 아래 조건 비교는 관측 통계입니다. 타자별
                기대 확률은 별도의 구질 유사도·기대 반응 패널에서 검증 상태와 함께 확인합니다.
              </p>
              <p>
                Swing% = 스윙/투구, Whiff% = 헛스윙/스윙, 루킹/투구 = 루킹 스트라이크/투구입니다.
                모델 패널의 루킹/비스윙과는 분모가 다릅니다. 분모가 없으면 —로 표시합니다.
              </p>
            </details>
            <details className="matchup-detail">
              <summary>관측 반응 상세 기록</summary>
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
                        "루킹/투구",
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
                        <td>
                          <SampleRate
                            value={c.value.swingRate}
                            numerator={c.value.swings}
                            denominator={c.value.pitches}
                            unit="구"
                          />
                        </td>
                        <td>
                          <SampleRate
                            value={c.value.whiffRate}
                            numerator={c.value.whiffs}
                            denominator={c.value.swings}
                            unit="스윙"
                          />
                        </td>
                        <td>
                          <SampleRate
                            value={c.value.calledStrikeRate}
                            denominator={c.value.pitches}
                            unit="구"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <details className="matchup-detail">
              <summary>직접 맞대결 타석 · {data.directPlateAppearances.length}개</summary>
              <p>
                공식 타석 책임 기준 직접 상대 PA {data.directPlateAppearances.length}개. 타석 중
                선수 교체가 있으면 실제 맞대결 투구의 타석 수와 다를 수 있습니다.
              </p>
              <ul>
                {data.directPlateAppearances.map((p, i) => (
                  <li key={`${p.gameId}-${p.paId}`}>
                    <AnalysisEvidenceLink
                      to={replayEvidenceUrl(p.gameId, p.revision, { kind: "pa", id: p.paId })}
                    >
                      {p.gameDate} · 맞대결 타석 {i + 1} · {plateResultLabel(p.result)} · 장면 보기
                    </AnalysisEvidenceLink>
                    <details className="analysis-evidence-id">
                      <summary>근거 ID · r{p.revision}</summary>
                      {p.paId}
                    </details>
                  </li>
                ))}
              </ul>
            </details>
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
                    <th>루킹/투구</th>
                    <td>{data.matched.pitches}구</td>
                    <td>{percent(data.matched.observedCalledStrikeRate)}</td>
                    <td>{percent(data.matched.leagueCalledStrikeRate)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <MatchupModelPanel query={query} />
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
                    {[
                      "경기",
                      "투수",
                      "투구 근거",
                      "구종",
                      "구속 km/h",
                      "카운트",
                      "타석",
                      "결과",
                    ].map((v) => (
                      <th key={v}>{v}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data[sample].rows.slice(page * 25, page * 25 + 25).map((p) => (
                    <tr key={JSON.stringify([p.gameId, p.revision, p.pitchId])}>
                      <td>
                        <AnalysisEvidenceLink
                          to={replayEvidenceUrl(p.gameId, p.revision, {
                            kind: "event",
                            id: p.pitchId,
                          })}
                        >
                          {p.gameDate} r{p.revision}
                        </AnalysisEvidenceLink>
                      </td>
                      <td>
                        {catalog.data?.pitchers.find((player) => player.pitcherId === p.pitcherId)
                          ?.name ?? (p.pitcherId ? `선수 ID ${p.pitcherId}` : "미상")}
                      </td>
                      <td>
                        <details className="analysis-evidence-id">
                          <summary>투구 ID</summary>
                          {p.pitchId}
                        </details>
                      </td>
                      <td>{p.pitchType ?? "미상"}</td>
                      <td>{p.speedKph ?? "—"}</td>
                      <td>
                        {p.balls}-{p.strikes}
                      </td>
                      <td>
                        {p.stance === "L"
                          ? "좌타석"
                          : p.stance === "R"
                            ? "우타석"
                            : p.stance === "S"
                              ? "양타"
                              : "미상"}
                      </td>
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
