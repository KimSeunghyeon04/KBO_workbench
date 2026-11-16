import type { BattingStatisticsRow, PitchingStatisticsRow } from "@kbo/contracts";
import { formatInnings, formatStatNumber, formatStatPercent } from "./statistics-format";
import "../styles/player-record-summary.css";

function TeamRecordSummary({
  team,
  sample,
  kind,
  metrics,
  note,
}: {
  team: string;
  sample: string;
  kind: string;
  metrics: readonly { label: string; value: string; detail?: string }[];
  note?: string;
}) {
  return (
    <section className="player-record-summary" aria-label={`${team} 핵심 ${kind} 기록`}>
      <div className="player-record-summary-heading">
        <h2>
          {team} · 핵심 {kind} 기록
        </h2>
        <span>{sample}</span>
      </div>
      <dl>
        {metrics.map(({ label, value, detail }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {value}
              {detail && <span className="player-record-metric-detail">{detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {note && <p className="analysis-caption">{note}</p>}
    </section>
  );
}

export function BattingRecordSummary({ rows }: { rows: readonly BattingStatisticsRow[] }) {
  return rows.map((row) => (
    <TeamRecordSummary
      key={JSON.stringify([row.identity, row.teamId])}
      team={row.teamName}
      kind="타격"
      sample={`${row.games.toLocaleString()}경기 · ${row.plateAppearances.toLocaleString()}타석 · ${row.atBats.toLocaleString()}타수`}
      metrics={[
        { label: "타율 AVG", value: formatStatNumber(row.avg) },
        { label: "출루율 OBP", value: formatStatNumber(row.obp) },
        { label: "장타율 SLG", value: formatStatNumber(row.slg) },
        { label: "OPS", value: formatStatNumber(row.ops) },
      ]}
    />
  ));
}

export function PitchingRecordSummary({ rows }: { rows: readonly PitchingStatisticsRow[] }) {
  return rows.map((row) => (
    <TeamRecordSummary
      key={JSON.stringify([row.identity, row.teamId])}
      team={row.teamName}
      kind="투구"
      sample={`${row.games.toLocaleString()}경기 · ${row.battersFaced.toLocaleString()}타자 상대 · ${row.pitches.toLocaleString()}구`}
      metrics={[
        {
          label: "평균자책점 ERA",
          value: formatStatNumber(row.era, 2),
          ...(row.era === null
            ? {
                detail: `자책점 확인 ${row.knownErGames}/${row.games}경기 · 전체 ERA를 확정할 수 없습니다.`,
              }
            : {}),
        },
        { label: "이닝 IP", value: formatInnings(row.outsRecorded) },
        { label: "삼진 비율 K%", value: formatStatPercent(row.kRate) },
        { label: "볼넷 비율 BB%", value: formatStatPercent(row.bbRate) },
      ]}
      note="삼진·볼넷 비율은 공식 상대 타자 수(BF)가 분모입니다."
    />
  ));
}
