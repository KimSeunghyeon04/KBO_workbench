import type {
  BattingStatisticsQuery,
  BattingStatisticsRow,
  PitchingStatisticsQuery,
  PitchingStatisticsRow,
} from "@kbo/contracts";
import { Link } from "react-router-dom";
import {
  formatStatNumber as number,
  formatStatPercent as percent,
  formatInnings as innings,
} from "./statistics-format";
import "../styles/player-statistics.css";

type StatisticsView = "summary" | "full";
type Identity = Pick<
  BattingStatisticsRow,
  "identity" | "name" | "teamId" | "teamName" | "playerId"
>;
interface Column<Row> {
  key: string;
  label: string;
  value: (row: Row) => string | number;
  fullOnly?: true;
  summaryLabel?: string;
}

const battingColumns: readonly Column<BattingStatisticsRow>[] = [
  { key: "team", label: "당시 팀", value: (r) => r.teamName },
  { key: "games", label: "경기", value: (r) => r.games, fullOnly: true },
  { key: "plateAppearances", label: "PA", value: (r) => r.plateAppearances },
  { key: "atBats", label: "AB", value: (r) => r.atBats, fullOnly: true },
  { key: "hits", label: "H", value: (r) => r.hits, fullOnly: true },
  { key: "doubles", label: "2B", value: (r) => r.doubles, fullOnly: true },
  { key: "triples", label: "3B", value: (r) => r.triples, fullOnly: true },
  { key: "homeRuns", label: "HR", value: (r) => r.homeRuns },
  {
    key: "walks",
    label: "BB (IBB)",
    value: (r) => r.walks + " (" + r.intentionalWalks + ")",
    fullOnly: true,
  },
  { key: "hitByPitch", label: "HBP", value: (r) => r.hitByPitch, fullOnly: true },
  { key: "strikeouts", label: "SO", value: (r) => r.strikeouts, fullOnly: true },
  { key: "sacrificeFlies", label: "SF", value: (r) => r.sacrificeFlies, fullOnly: true },
  { key: "sacrificeBunts", label: "SH", value: (r) => r.sacrificeBunts, fullOnly: true },
  { key: "runs", label: "R", value: (r) => r.runs, fullOnly: true },
  { key: "totalBases", label: "TB", value: (r) => r.totalBases, fullOnly: true },
  { key: "avg", label: "AVG", value: (r) => number(r.avg) },
  { key: "obp", label: "OBP", value: (r) => number(r.obp) },
  { key: "slg", label: "SLG", value: (r) => number(r.slg) },
  { key: "ops", label: "OPS", value: (r) => number(r.ops) },
  { key: "kRate", label: "K%", value: (r) => percent(r.kRate) },
  { key: "bbRate", label: "BB%", value: (r) => percent(r.bbRate) },
];

const pitchingColumns: readonly Column<PitchingStatisticsRow>[] = [
  { key: "team", label: "당시 팀", value: (r) => r.teamName },
  { key: "games", label: "경기", value: (r) => r.games, fullOnly: true },
  { key: "battersFaced", label: "BF", value: (r) => r.battersFaced },
  { key: "outsRecorded", label: "이닝", summaryLabel: "IP", value: (r) => innings(r.outsRecorded) },
  { key: "hits", label: "H", value: (r) => r.hits, fullOnly: true },
  { key: "runs", label: "R", value: (r) => r.runs, fullOnly: true },
  {
    key: "walks",
    label: "BB (IBB)",
    value: (r) => r.walks + " (" + r.intentionalWalks + ")",
    fullOnly: true,
  },
  { key: "hitByPitch", label: "HBP", value: (r) => r.hitByPitch, fullOnly: true },
  { key: "strikeouts", label: "SO", value: (r) => r.strikeouts, fullOnly: true },
  { key: "pitches", label: "투구", value: (r) => r.pitches },
  { key: "strikes", label: "스트라이크", value: (r) => r.strikes, fullOnly: true },
  { key: "kRate", label: "K%", value: (r) => percent(r.kRate) },
  { key: "bbRate", label: "BB%", value: (r) => percent(r.bbRate) },
  { key: "kMinusBbRate", label: "K−BB%", value: (r) => percent(r.kMinusBbRate) },
  { key: "era", label: "ERA", value: (r) => number(r.era, 2) },
  { key: "knownErGames", label: "ER 확인 경기", value: (r) => r.knownErGames + "/" + r.games },
  { key: "knownErOuts", label: "확인 이닝", value: (r) => innings(r.knownErOuts), fullOnly: true },
  {
    key: "knownEarnedRuns",
    label: "확인 ER",
    value: (r) => (r.knownErGames === 0 ? "—" : r.knownEarnedRuns),
    fullOnly: true,
  },
  {
    key: "knownGamesEra",
    label: "확인 경기 ERA",
    value: (r) => number(r.knownGamesEra, 2),
    fullOnly: true,
  },
];

interface StatisticsTableProps<Row, Sort extends string> {
  rows: readonly Row[];
  detail?: (id: string) => string;
  view?: StatisticsView;
  sort?: Sort;
}

function StatisticsTable<Row extends Identity>({
  rows,
  detail,
  view = "full",
  sort,
  columns,
  label,
  sampleKey,
}: StatisticsTableProps<Row, string> & {
  columns: readonly Column<Row>[];
  label: string;
  sampleKey: string;
}) {
  const visible = view === "full" ? columns : columns.filter(({ fullOnly }) => !fullOnly);
  const prioritized = sort === undefined ? new Set<string>() : new Set([sampleKey, sort]);
  const ordered = [
    ...[...prioritized].flatMap((key) => visible.filter((column) => column.key === key)),
    ...visible.filter(({ key }) => !prioritized.has(key)),
  ];
  return (
    <div className="table-scroll player-statistics-table league-statistics-table" tabIndex={0}>
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">선수/팀</th>
            {ordered.map(({ key, label: title, summaryLabel }) => (
              <th
                key={key}
                scope="col"
                className={key === "team" ? "statistics-team" : undefined}
                aria-sort={key === sort ? (sort === "era" ? "ascending" : "descending") : undefined}
              >
                {view === "summary" ? (summaryLabel ?? title) : title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={JSON.stringify([row.identity, row.teamId])}>
              <th scope="row">
                {row.playerId === null || detail === undefined ? (
                  row.name
                ) : (
                  <Link to={detail(row.playerId)}>{row.name}</Link>
                )}
              </th>
              {ordered.map(({ key, value }) => (
                <td key={key} className={key === "team" ? "statistics-team" : undefined}>
                  {value(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BattingTable(
  props: StatisticsTableProps<BattingStatisticsRow, NonNullable<BattingStatisticsQuery["sort"]>>,
) {
  return (
    <>
      <StatisticsTable
        {...props}
        label="타격 성적"
        columns={battingColumns}
        sampleKey="plateAppearances"
      />
      {props.view !== "summary" && (
        <p className="analysis-caption">
          G(경기)는 수집 원장에서 타격 기록이 생성된 경기 수입니다. 무타석·무득점 출전은 빠질 수
          있어 공식 출전 경기 수와 다를 수 있습니다.
        </p>
      )}
      <p className="analysis-caption">
        OPS는 반올림 전 OBP와 SLG를 더한 뒤 표시합니다. 화면에 표시된 OBP+SLG와 마지막 자리가 다를
        수 있습니다.
      </p>
    </>
  );
}

export function PitchingTable(
  props: StatisticsTableProps<PitchingStatisticsRow, NonNullable<PitchingStatisticsQuery["sort"]>>,
) {
  return (
    <>
      <StatisticsTable
        {...props}
        label="투구 성적"
        columns={pitchingColumns}
        sampleKey="battersFaced"
      />
      {props.view !== "summary" && (
        <p className="analysis-caption">
          G(경기)는 수집 원장에서 투구 기록이 생성된 경기 수입니다. 투구 등 실적이 없는 등판은 빠질
          수 있어 공식 출전 경기 수와 다를 수 있습니다.
        </p>
      )}
      <p className="analysis-caption">
        자책점 미확인 경기가 있으면 전체 ERA는 —입니다. 확인 경기 ERA는 해당 경기의 아웃 수만 분모에
        넣습니다.
      </p>
    </>
  );
}
