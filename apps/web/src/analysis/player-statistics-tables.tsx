import type { BattingStatisticsRow, PitchingStatisticsRow } from "@kbo/contracts";
import { Link } from "react-router-dom";
import {
  formatStatNumber as number,
  formatStatPercent as percent,
  formatInnings as innings,
} from "./statistics-format";
import "../styles/player-statistics.css";

export function BattingTable({
  rows,
  detail,
  view = "full",
}: {
  rows: readonly BattingStatisticsRow[];
  detail?: (id: string) => string;
  view?: "summary" | "full";
}) {
  const summary = view === "summary";
  return (
    <>
      {!summary && (
        <p className="analysis-caption">
          G(경기)는 수집 원장에서 타격 기록이 생성된 경기 수입니다. 무타석·무득점 출전은 빠질 수
          있어 공식 출전 경기 수와 다를 수 있습니다.
        </p>
      )}
      <p className="analysis-caption">
        OPS는 반올림 전 OBP와 SLG를 더한 뒤 표시합니다. 화면에 표시된 OBP+SLG와 마지막 자리가 다를
        수 있습니다.
      </p>
      <div className="table-scroll player-statistics-table" tabIndex={0}>
        <table aria-label="타격 성적">
          <thead>
            <tr>
              {[
                "선수/팀",
                "당시 팀",
                ...(summary
                  ? ["PA", "HR", "AVG", "OBP", "SLG", "OPS", "K%", "BB%"]
                  : [
                      "경기",
                      "PA",
                      "AB",
                      "H",
                      "2B",
                      "3B",
                      "HR",
                      "BB (IBB)",
                      "HBP",
                      "SO",
                      "SF",
                      "SH",
                      "R",
                      "TB",
                      "AVG",
                      "OBP",
                      "SLG",
                      "OPS",
                      "K%",
                      "BB%",
                    ]),
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
                  ...(summary
                    ? [
                        r.plateAppearances,
                        r.homeRuns,
                        number(r.avg),
                        number(r.obp),
                        number(r.slg),
                        number(r.ops),
                        percent(r.kRate),
                        percent(r.bbRate),
                      ]
                    : [
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
                        r.sacrificeFlies,
                        r.sacrificeBunts,
                        r.runs,
                        r.totalBases,
                        number(r.avg),
                        number(r.obp),
                        number(r.slg),
                        number(r.ops),
                        percent(r.kRate),
                        percent(r.bbRate),
                      ]),
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
export function PitchingTable({
  rows,
  detail,
  view = "full",
}: {
  rows: readonly PitchingStatisticsRow[];
  detail?: (id: string) => string;
  view?: "summary" | "full";
}) {
  const summary = view === "summary";
  return (
    <>
      {!summary && (
        <p className="analysis-caption">
          G(경기)는 수집 원장에서 투구 기록이 생성된 경기 수입니다. 투구 등 실적이 없는 등판은 빠질
          수 있어 공식 출전 경기 수와 다를 수 있습니다.
        </p>
      )}
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
                ...(summary
                  ? ["BF", "IP", "ERA", "K%", "BB%", "K−BB%", "투구", "ER 확인 경기"]
                  : [
                      "경기",
                      "BF",
                      "이닝",
                      "H",
                      "R",
                      "BB (IBB)",
                      "HBP",
                      "SO",
                      "투구",
                      "스트라이크",
                      "K%",
                      "BB%",
                      "K−BB%",
                      "ERA",
                      "ER 확인 경기",
                      "확인 이닝",
                      "확인 ER",
                      "확인 경기 ERA",
                    ]),
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
                  ...(summary
                    ? [
                        r.battersFaced,
                        innings(r.outsRecorded),
                        number(r.era, 2),
                        percent(r.kRate),
                        percent(r.bbRate),
                        percent(r.kMinusBbRate),
                        r.pitches,
                        `${r.knownErGames}/${r.games}`,
                      ]
                    : [
                        r.games,
                        r.battersFaced,
                        innings(r.outsRecorded),
                        r.hits,
                        r.runs,
                        `${r.walks} (${r.intentionalWalks})`,
                        r.hitByPitch,
                        r.strikeouts,
                        r.pitches,
                        r.strikes,
                        percent(r.kRate),
                        percent(r.bbRate),
                        percent(r.kMinusBbRate),
                        number(r.era, 2),
                        `${r.knownErGames}/${r.games}`,
                        innings(r.knownErOuts),
                        r.knownErGames === 0 ? "—" : r.knownEarnedRuns,
                        number(r.knownGamesEra, 2),
                      ]),
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
