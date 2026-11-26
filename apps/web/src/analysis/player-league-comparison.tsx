import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  defaultAnalysisCompetition,
  type PlayerGameRecordsQuery,
  type PlayerLeagueResponse,
} from "@kbo/contracts";
import { getPlayerLeague } from "../api/player-statistics-client";
import { analysisQueryMeta } from "./analysis-query-meta";
import { AnalysisQueryError } from "./analysis-query-error";
import { analysisScopeSearch } from "./analysis-scope";
import { competitionLabels } from "./analysis-scope-fields";
import { PlayerRecordTable } from "./player-record-table";
import { formatInnings, formatStatNumber, formatStatPercent } from "./statistics-format";

function LeagueTable({ data }: { data: PlayerLeagueResponse }) {
  const rows = (["player", "league"] as const).map((id) => {
    const heading = id === "player" ? "선택 선수" : "리그 전체";
    const row = data[id];
    return {
      id,
      heading,
      values:
        row === null
          ? Array<string>(6).fill("—")
          : "atBats" in row
            ? [
                row.plateAppearances,
                row.atBats,
                formatStatNumber(row.avg),
                formatStatNumber(row.obp),
                formatStatNumber(row.slg),
                formatStatNumber(row.ops),
              ]
            : [
                row.battersFaced,
                formatInnings(row.outsRecorded),
                formatStatPercent(row.kRate),
                formatStatPercent(row.bbRate),
                formatStatNumber(row.knownGamesEra, 2),
                formatInnings(row.knownErOuts),
              ],
    };
  });
  return (
    <PlayerRecordTable
      label="선수와 리그 평균 비교"
      columns={
        data.role === "batter"
          ? ["표본", "타석", "타수", "타율", "출루율", "장타율", "OPS"]
          : ["표본", "상대 타자", "이닝", "삼진율", "볼넷율", "확인 경기 ERA", "ER 확인 이닝"]
      }
      rows={rows}
    />
  );
}

export function PlayerLeagueComparison({ query }: { query: PlayerGameRecordsQuery }) {
  const [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ["player-league-statistics", query],
    meta: analysisQueryMeta(query),
    enabled: open,
    queryFn: ({ signal }) => getPlayerLeague(query, signal),
  });
  const { player, role, source, season, ...scope } = query;
  void player;
  void source;
  const leaderboard = new URLSearchParams(analysisScopeSearch(season, scope));
  leaderboard.set("kind", role === "batter" ? "batting" : "pitching");
  const competition = competitionLabels[scope.competition ?? defaultAnalysisCompetition];
  return (
    <details
      className="panel player-report-filters"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>
          {season}년 {competition} 리그 평균과 비교
        </strong>
        {(scope.dateFrom !== undefined || scope.dateTo !== undefined) && (
          <span className="player-league-comparison-dates">
            {scope.dateFrom ?? "시즌 시작"} ~ {scope.dateTo ?? "시즌 끝"}
          </span>
        )}
      </summary>
      {open && (
        <div className="player-league-comparison">
          {result.isFetching && <p role="status">리그 성적을 읽고 있습니다.</p>}
          <AnalysisQueryError queries={[result]} />
          {result.data && (
            <>
              <LeagueTable data={result.data} />
              <p className="analysis-caption">
                리그 평균은 표시된 범위에서 리그 전체의 분자와 분모를 각각 합산해 계산합니다.
                {query.role === "pitcher" && " ERA는 자책점이 확인된 이닝을 사용합니다."}
              </p>
            </>
          )}
          <Link to={`/analysis/statistics?${leaderboard}`}>같은 조건으로 선수·팀 성적 보기</Link>
        </div>
      )}
    </details>
  );
}
