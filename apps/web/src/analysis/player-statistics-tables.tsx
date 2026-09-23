import type { BattingStatisticsRow, PitchingStatisticsRow } from "@kbo/contracts";
import { Link } from "react-router-dom";
import "../styles/player-statistics.css";

const number = (n: number | null, digits = 3) => (n === null ? "—" : n.toFixed(digits));
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const innings = (outs: number) =>
  `${Math.floor(outs / 3)}${outs % 3 === 0 ? "" : outs % 3 === 1 ? "⅓" : "⅔"}`;

export function BattingTable({
  rows,
  detail,
  basic = false,
}: {
  rows: readonly BattingStatisticsRow[];
  detail?: (id: string) => string;
  basic?: boolean;
}) {
  return (
    <div className="table-scroll player-statistics-table" tabIndex={0}>
      <table aria-label="타격 성적">
        <thead>
          <tr>
            {[
              "선수/팀",
              "당시 팀",
              basic ? "G" : "경기",
              "PA",
              "AB",
              "H",
              "2B",
              "3B",
              "HR",
              "BB (IBB)",
              "HBP",
              "SO",
              ...(basic ? [] : ["SF", "SH"]),
              "R",
              ...(basic ? [] : ["TB"]),
              "AVG",
              "OBP",
              "SLG",
              "OPS",
              ...(basic ? [] : ["K%", "BB%"]),
            ].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={JSON.stringify([r.identity, r.teamId])}>
              <th scope="row">
                {r.playerId === null || detail === undefined ? (
                  r.name
                ) : (
                  <Link to={detail(r.playerId)}>{r.name}</Link>
                )}
              </th>
              <td>{r.teamName}</td>
              {[
                r.games,
                r.plateAppearances,
                r.atBats,
                r.hits,
                r.doubles,
                r.triples,
                r.homeRuns,
                `${r.walks} (${r.intentionalWalks})`,
                r.hitByPitch,
                r.strikeouts,
                ...(basic ? [] : [r.sacrificeFlies, r.sacrificeBunts]),
                r.runs,
                ...(basic ? [] : [r.totalBases]),
                number(r.avg),
                number(r.obp),
                number(r.slg),
                number(r.ops),
                ...(basic ? [] : [percent(r.kRate), percent(r.bbRate)]),
              ].map((x, i) => (
                <td key={i}>{x}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function PitchingTable({
  rows,
  detail,
  basic = false,
}: {
  rows: readonly PitchingStatisticsRow[];
  detail?: (id: string) => string;
  basic?: boolean;
}) {
  return (
    <>
      <p>
        자책점 미확인 경기가 있으면 전체 ERA는 —입니다. 확인 경기 ERA는 해당 경기의 아웃 수만 분모에
        넣습니다.
      </p>
      <div className="table-scroll player-statistics-table" tabIndex={0}>
        <table aria-label="투구 성적">
          <thead>
            <tr>
              {[
                "선수/팀",
                "당시 팀",
                basic ? "G" : "경기",
                "BF",
                basic ? "IP" : "이닝",
                "H",
                "R",
                "BB (IBB)",
                "HBP",
                "SO",
                "투구",
                ...(basic ? [] : ["스트라이크", "K%", "BB%", "K−BB%"]),
                "ERA",
                "ER 확인 경기",
                "확인 이닝",
                "확인 ER",
                "확인 경기 ERA",
              ].map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={JSON.stringify([r.identity, r.teamId])}>
                <th scope="row">
                  {r.playerId === null || detail === undefined ? (
                    r.name
                  ) : (
                    <Link to={detail(r.playerId)}>{r.name}</Link>
                  )}
                </th>
                <td>{r.teamName}</td>
                {[
                  r.games,
                  r.battersFaced,
                  innings(r.outsRecorded),
                  r.hits,
                  r.runs,
                  `${r.walks} (${r.intentionalWalks})`,
                  r.hitByPitch,
                  r.strikeouts,
                  r.pitches,
                  ...(basic
                    ? []
                    : [r.strikes, percent(r.kRate), percent(r.bbRate), percent(r.kMinusBbRate)]),
                  number(r.era, 2),
                  `${r.knownErGames}/${r.games}`,
                  innings(r.knownErOuts),
                  r.knownErGames === 0 ? "—" : r.knownEarnedRuns,
                  number(r.knownGamesEra, 2),
                ].map((x, i) => (
                  <td key={i}>{x}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
