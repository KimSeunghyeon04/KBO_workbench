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
import { analysisCatalogPlayers, selectedPlayerRole } from "../analysis/player-analysis-navigation";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getDirectMatchup, getMatchup, getMatchupOpponents } from "../api/matchup-client";
import { PlayerSearch, reportPlayerOption } from "../analysis/player-analysis-search";
import { MatchupModelPanel } from "../analysis/matchup-model-panel";
import { MatchupObservedSummary } from "../analysis/matchup-observed-summary";
import { PlayerRecordTable } from "../analysis/player-record-table";
import { formatStatNumber } from "../analysis/statistics-format";
import "../styles/pitch-analysis.css";
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
export function MatchupPage() {
  const { params, season, scope, change } = useAnalysisScope();
  const [sample, setSample] = useState<"direct" | "similar">("direct");
  const [compare, setCompare] = useState(false);
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
  const actorRole = selectedPlayerRole(params);
  const opponentIsPitcher = actorRole === "batter";
  const opponentRole = opponentIsPitcher ? "pitcher" : "batter";
  const opponentLabel = opponentIsPitcher ? "상대 투수" : "상대 타자";
  const opponentId = opponentIsPitcher ? pitcherId : batterId;
  const opponentCatalog = opponentIsPitcher ? catalog : batters;
  const actorId = opponentIsPitcher ? batterId : pitcherId;
  const opponentQuery = { season, ...scope.options, role: actorRole, playerId: actorId };
  const opponentList = useQuery({
    queryKey: ["matchup-opponents", opponentQuery],
    meta: analysisQueryMeta(opponentQuery),
    enabled: scope.error === null && actorId !== "",
    queryFn: ({ signal }) => getMatchupOpponents(opponentQuery, signal),
  });
  const catalogOptions = opponentCatalog.data ? analysisCatalogPlayers(opponentCatalog.data) : [];
  const available = new Map(catalogOptions.map((player) => [player.id, player]));
  const opponents = (opponentList.data?.players ?? []).flatMap((player) => {
    const known = available.get(player.id);
    const direct = player.pitches > 0 || player.plateAppearances > 0;
    if (!known && !direct) return [];
    available.delete(player.id);
    return [
      reportPlayerOption(
        player.id,
        known?.name ?? player.name,
        player.teams,
        direct ? `직접 상대 · ${player.plateAppearances}타석 · ${player.pitches}구` : undefined,
      ),
    ];
  });
  opponents.push(
    ...[...available.values()].map(({ id, name }) => reportPlayerOption(id, name, [])),
  );
  const selectedOpponent = opponents.find(({ id }) => id === opponentId);
  useEffect(
    () => setPage(0),
    [
      season,
      scope.options.competition,
      scope.options.dateFrom,
      scope.options.dateTo,
      pitcherId,
      batterId,
    ],
  );
  const enabled = scope.error === null && pitcherId !== "" && batterId !== "";
  const direct = useQuery({
    queryKey: ["direct-matchup", query],
    meta: analysisQueryMeta(query),
    enabled,
    queryFn: ({ signal }) => getDirectMatchup(query, signal),
  });
  const result = useQuery({
    queryKey: ["matchup", query],
    meta: analysisQueryMeta(query),
    enabled: enabled && compare,
    queryFn: ({ signal }) => getMatchup(query, signal),
  });
  const data = result.data;
  const matchup = direct.data;
  const batting = matchup?.batting;
  const evidence = (sample === "similar" && compare ? data?.similar : matchup?.direct)?.rows ?? [];
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>투타 맞대결</h1>
        </div>
      </header>
      <section className="panel analysis-player-picker" aria-label="맞대결 상대">
        <PlayerSearch
          label={opponentLabel + " 검색"}
          placeholder={opponentLabel + " 이름·팀 또는 ID"}
          players={opponentList.isLoading || opponentCatalog.isLoading ? undefined : opponents}
          selectedId={opponentId}
          unavailable="상대 목록을 읽고 있습니다."
          onSelect={(id) => change(opponentRole, id)}
          suggestOnFocus
        />
        {opponentId !== "" && (
          <p className="analysis-caption">
            선택한 {opponentLabel} ·{" "}
            {selectedOpponent
              ? selectedOpponent.name + " · " + selectedOpponent.details
              : "ID " + opponentId}
          </p>
        )}
        {opponentList.isError && (
          <div role="status">
            상대의 직접 기록과 시즌 팀을 읽지 못했습니다.{" "}
            <button
              type="button"
              className="secondary-button"
              onClick={() => void opponentList.refetch()}
            >
              상대 목록 다시 시도
            </button>
          </div>
        )}
      </section>
      {opponentCatalog.isSuccess &&
        opponentList.isSuccess &&
        opponentId !== "" &&
        !selectedOpponent && (
          <p role="status">
            {opponentLabel}(ID {opponentId})의 기록이 이 조회 범위에 없습니다.
          </p>
        )}
      {scope.error && <p role="alert">{scope.error}</p>}
      <AnalysisQueryError queries={[direct, catalog, batters]} enabled={scope.error === null} />
      {(catalog.isLoading || batters.isLoading || direct.isFetching) && (
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
      {matchup && batting && (
        <section className="player-season-records">
          <div>
            <h2>직접 맞대결</h2>
            <PlayerRecordTable
              label="직접 맞대결 성적"
              columns={["표본", "타석", "타수", "안타", "홈런", "볼넷", "삼진", "타율", "OPS"]}
              rows={[
                {
                  id: "direct",
                  heading: "직접 상대",
                  values: [
                    batting.plateAppearances,
                    batting.atBats,
                    batting.hits,
                    batting.homeRuns,
                    batting.walks,
                    batting.strikeouts,
                    formatStatNumber(batting.avg),
                    formatStatNumber(batting.ops),
                  ],
                },
              ]}
            />
          </div>
          <p className="analysis-caption">
            직접 상대 투구 {matchup.direct.pitches.toLocaleString()}구 · {matchup.direct.games}경기.
            타석은 기록상 타자·투수 책임으로 집계합니다.
          </p>
          {matchup.directPlateAppearances.length > 0 && (
            <details className="matchup-detail">
              <summary>맞대결 타석 재생 · {matchup.directPlateAppearances.length}개</summary>
              <ul>
                {matchup.directPlateAppearances.map((appearance) => (
                  <li key={`${appearance.gameId}-${appearance.paId}`}>
                    <AnalysisEvidenceLink
                      to={replayEvidenceUrl(appearance.gameId, appearance.revision, {
                        kind: "pa",
                        id: appearance.paId,
                      })}
                    >
                      {appearance.gameDate} · {plateResultLabel(appearance.result)} · 장면 보기
                    </AnalysisEvidenceLink>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {matchup && (
        <details
          className="panel player-report-filters"
          onToggle={(event) => {
            setCompare(event.currentTarget.open);
            if (!event.currentTarget.open && sample === "similar") {
              setSample("direct");
              setPage(0);
            }
          }}
        >
          <summary>
            <strong>유사 조건의 투구와 비교</strong>
          </summary>
          {compare && result.isFetching && <p role="status">유사 조건 표본을 읽고 있습니다.</p>}
          {compare && <AnalysisQueryError queries={[result]} />}
          {compare && data && (
            <>
              <section className="panel">
                <MatchupObservedSummary direct={data.direct} similar={data.similar} />
                <details className="matchup-detail">
                  <summary>표본 기준과 분모</summary>
                  <p>
                    직접 표본은 실제 맞대결 투구 전체입니다. 유사 표본은 선택 투수가 던진 공과 원
                    구종·카운트·타석 좌우·5 km/h 구간이 같은 이 타자의 공입니다. HBP·IBB·번트를
                    제외하며 구속·구종·타석이 미상 또는 구속이 0–500 km/h 범위 밖이면 조건을 만들지
                    않습니다. 유사 조건에서 제외된 타자 투구 {data.excludedSimilar}구.
                  </p>
                  <p>
                    두 표본은 겹칠 수 있어 합산하지 않습니다. 아래 조건 비교는 관측 통계입니다.
                    타자별 기대 확률은 별도의 구질 유사도·기대 반응 패널에서 검증 상태와 함께
                    확인합니다.
                  </p>
                  <p>
                    Swing% = 스윙/투구, Whiff% = 헛스윙/스윙, 루킹/투구 = 루킹
                    스트라이크/투구입니다. 모델 패널의 루킹/비스윙과는 분모가 다릅니다. 분모가
                    없으면 —로 표시합니다.
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
            </>
          )}
        </details>
      )}
      {matchup && (
        <>
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
                {compare && data && <option value="similar">유사 조건</option>}
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
                  {evidence.slice(page * 25, page * 25 + 25).map((p) => (
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
            <button disabled={(page + 1) * 25 >= evidence.length} onClick={() => setPage(page + 1)}>
              다음
            </button>
          </section>
        </>
      )}
    </div>
  );
}
