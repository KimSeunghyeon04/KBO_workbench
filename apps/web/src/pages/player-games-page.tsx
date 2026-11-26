import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { PlayerGameRecordsQuerySchema, type PlayerGameRecordsResponse } from "@kbo/contracts";
import { AnalysisEvidenceLink } from "../analysis/analysis-evidence-link";
import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { playerAnalysisHref } from "../analysis/player-analysis-navigation";
import { PlayerRecordConditions } from "../analysis/player-record-conditions";
import { PlayerRecordTable } from "../analysis/player-record-table";
import { usePlayerRecordScope } from "../analysis/use-player-record-scope";
import { analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { formatInnings } from "../analysis/statistics-format";
import { getPlayerGameRecords } from "../api/player-statistics-client";
import { replayGameUrl } from "../replay/evidence-target";

const sideLabels = { away: "원정", home: "홈", both: "홈·원정" };

function GameRecords({ data }: { data: PlayerGameRecordsResponse }) {
  const label = data.role === "batter" ? "경기별 타격 성적" : "경기별 등판 성적";
  const game = (row: PlayerGameRecordsResponse["rows"][number]) => ({
    id: row.gameId,
    heading: (
      <AnalysisEvidenceLink
        to={replayGameUrl(row.gameId, row.revision)}
        label={`${row.gameDate} · ${row.opponents.join(" · ")} 경기 재생`}
      >
        {row.gameDate}
      </AnalysisEvidenceLink>
    ),
    context: [row.opponents.join(" · "), sideLabels[row.side], row.teams.join(" · ")],
  });
  return (
    <PlayerRecordTable
      label={label}
      columns={[
        "날짜",
        "상대",
        "구분",
        "팀",
        ...(data.role === "batter"
          ? ["타석", "타수", "안타", "홈런", "볼넷", "삼진", "득점"]
          : ["이닝", "상대 타자", "피안타", "실점", "자책점", "볼넷", "삼진", "투구 수"]),
      ]}
      rows={
        data.role === "batter"
          ? data.rows.map((row) => {
              const { id, heading, context } = game(row);
              return {
                id,
                heading,
                values: [
                  ...context,
                  row.plateAppearances,
                  row.atBats,
                  row.hits,
                  row.homeRuns,
                  row.walks,
                  row.strikeouts,
                  row.runs,
                ],
              };
            })
          : data.rows.map((row) => {
              const { id, heading, context } = game(row);
              return {
                id,
                heading,
                values: [
                  ...context,
                  formatInnings(row.outsRecorded),
                  row.battersFaced,
                  row.hits,
                  row.runs,
                  row.earnedRuns ?? "—",
                  row.walks,
                  row.strikeouts,
                  row.pitches,
                ],
              };
            })
      }
    />
  );
}

export function PlayerGamesPage() {
  const { season, selected, scope, query, identity, role, rawId, loading, change } =
    usePlayerRecordScope();
  const valid = Value.Check(PlayerGameRecordsQuerySchema, query);
  const error =
    scope.error ?? (query !== null && !valid ? "선수 조회 조건이 올바르지 않습니다." : null);
  const records = useQuery({
    queryKey: ["player-game-records", query],
    meta: analysisQueryMeta(season),
    enabled: error === null && valid && !loading,
    queryFn: ({ signal }) => {
      if (!Value.Check(PlayerGameRecordsQuerySchema, query))
        throw new Error("잘못된 경기별 조회 조건");
      return getPlayerGameRecords(query, signal);
    },
  });
  return (
    <div className="page-stack">
      <header className="page-header player-season-heading">
        <h1>경기별 성적</h1>
        {error === null && (
          <p className="analysis-caption">
            {season} · {analysisScopeSummary(selected)}
          </p>
        )}
      </header>
      {error !== null && <p role="alert">{error}</p>}
      {error === null && query === null && <p role="status">경기별 기록을 볼 선수를 선택하세요.</p>}
      {error === null && (loading || records.isFetching) && (
        <p role="status">경기별 기록을 읽고 있습니다.</p>
      )}
      {error === null && <AnalysisQueryError queries={[records]} />}
      {records.data?.rows.length === 0 && (
        <p role="status">선택한 범위에 경기별 기록이 없습니다.</p>
      )}
      {records.data && records.data.rows.length > 0 && <GameRecords data={records.data} />}
      {(records.data?.rows.length && role === "pitcher" && rawId && (
        <section className="player-report-related" aria-label="등판 심화 분석">
          <Link
            to={playerAnalysisHref(
              "/analysis/pitcher-changes",
              role,
              rawId,
              season,
              scope.options,
              undefined,
              identity ?? undefined,
            )}
          >
            최근 변화 · 최근 3경기와 직전 5경기
          </Link>
          <Link
            to={playerAnalysisHref(
              "/analysis/pitcher-workload",
              role,
              rawId,
              season,
              scope.options,
              undefined,
              identity ?? undefined,
            )}
          >
            등판 간격과 투구 부담
          </Link>
        </section>
      )) ||
        null}
      <PlayerRecordConditions selected={selected} season={season} change={change} />
    </div>
  );
}
