import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { PlayerGameRecordsQuery, PlayerLeagueResponse } from "@kbo/contracts";
import { getPlayerLeague } from "../api/player-statistics-client";
import { analysisQueryMeta } from "./analysis-query-meta";
import { AnalysisQueryError } from "./analysis-query-error";
import { analysisScopeSearch } from "./analysis-scope";
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
      label="같은 범위 리그 성적"
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
  return (
    <details
      className="panel player-report-filters"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>{query.season}년 같은 범위 리그와 비교</strong>
      </summary>
      {open && (
        <div className="player-league-comparison">
          {result.isFetching && <p role="status">리그 성적을 읽고 있습니다.</p>}
          <AnalysisQueryError queries={[result]} />
          {result.data && (
            <>
              <LeagueTable data={result.data} />
              <p className="analysis-caption">
                리그 비율은 같은 조회 범위의 분자와 분모를 각각 합산해 계산합니다.
                {query.role === "pitcher" && " ERA는 자책점이 확인된 이닝을 사용합니다."}
              </p>
            </>
          )}
          <Link to={`/analysis/statistics?${leaderboard}`}>같은 범위 선수·팀 순위 보기</Link>
        </div>
      )}
    </details>
  );
}
