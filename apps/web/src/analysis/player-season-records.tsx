import type { PlayerSeasonStatisticsResponse } from "@kbo/contracts";
import { formatInnings, formatStatNumber } from "./statistics-format";
import { PlayerRecordTable } from "./player-record-table";

function SeasonTable({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: readonly string[];
  rows: readonly {
    season: number;
    teams: readonly string[];
    values: readonly (string | number)[];
  }[];
}) {
  return (
    <PlayerRecordTable
      label={label}
      columns={["연도", "팀", ...columns]}
      rows={rows.map(({ season, teams, values }) => ({
        id: season,
        heading: season,
        values: [teams.join(" · "), ...values],
      }))}
    />
  );
}

export function PlayerSeasonRecords({
  batting,
  pitching,
}: Pick<PlayerSeasonStatisticsResponse, "batting" | "pitching">) {
  const both = batting.length > 0 && pitching.length > 0;
  return (
    <div className="player-season-records">
      {batting.length > 0 && (
        <section aria-label="타자 기본 기록">
          {both && <h2>타격</h2>}
          <SeasonTable
            label="연도별 타격 성적"
            columns={["경기", "타석", "홈런", "타율", "출루율", "장타율", "OPS"]}
            rows={batting.map((row) => ({
              season: row.season,
              teams: row.teams,
              values: [
                row.games,
                row.plateAppearances,
                row.homeRuns,
                formatStatNumber(row.avg),
                formatStatNumber(row.obp),
                formatStatNumber(row.slg),
                formatStatNumber(row.ops),
              ],
            }))}
          />
        </section>
      )}
      {pitching.length > 0 && (
        <section aria-label="투수 기본 기록">
          {both && <h2>투구</h2>}
          <SeasonTable
            label="연도별 투구 성적"
            columns={[
              "경기",
              "이닝",
              "상대 타자",
              "삼진",
              "볼넷",
              "평균자책점",
              "자책점 확인 경기",
            ]}
            rows={pitching.map((row) => ({
              season: row.season,
              teams: row.teams,
              values: [
                row.games,
                formatInnings(row.outsRecorded),
                row.battersFaced,
                row.strikeouts,
                row.walks,
                formatStatNumber(row.era, 2),
                `${row.knownErGames}/${row.games}`,
              ],
            }))}
          />
          {pitching.some((row) => row.knownErGames < row.games) && (
            <p className="analysis-caption">
              자책점이 미확인된 경기가 있으면 평균자책점은 —입니다.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
