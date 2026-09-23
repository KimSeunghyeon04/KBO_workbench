import { useMemo, useState, type ReactNode } from "react";
import type { PitchRateGroup, PitchLocationResponse, BatterProfileResponse } from "@kbo/contracts";
import { outcomeGroupLabel, outcomePercent as percent } from "./pitch-outcome-presentation";
import "../styles/analysis-stat-table.css";

const columns: readonly {
  label: string;
  value: (row: PitchRateGroup) => ReactNode;
  sortValue: (row: PitchRateGroup) => number | null;
  description: string;
  compact?: boolean;
}[] = [
  {
    label: "투구",
    value: (r) => r.pitches.toLocaleString(),
    sortValue: (r) => r.pitches,
    description: "실제 투구 수입니다. 자동 볼·스트라이크와 무투구 결과는 제외합니다.",
    compact: true,
  },
  {
    label: "스윙",
    value: (r) => r.swings,
    sortValue: (r) => r.swings,
    description: "스윙한 실제 투구 수입니다.",
  },
  {
    label: "헛스윙",
    value: (r) => r.whiffs,
    sortValue: (r) => r.whiffs,
    description: "헛스윙한 실제 투구 수입니다.",
  },
  {
    label: "Swing%",
    value: (r) => percent(r.swingRate),
    sortValue: (r) => r.swingRate,
    description: "스윙 수 / 실제 투구 수.",
    compact: true,
  },
  {
    label: "Whiff%",
    value: (r) => percent(r.whiffRate),
    sortValue: (r) => r.whiffRate,
    description: "헛스윙 수 / 스윙 수.",
    compact: true,
  },
  {
    label: "Contact%",
    value: (r) => percent(r.whiffRate === null ? null : 1 - r.whiffRate),
    sortValue: (r) => (r.whiffRate === null ? null : 1 - r.whiffRate),
    description: "(스윙 수 − 헛스윙 수) / 스윙 수. 파울을 포함합니다.",
  },
  {
    label: "SwStr%",
    value: (r) => percent(r.swingingStrikeRate),
    sortValue: (r) => r.swingingStrikeRate,
    description: "헛스윙 수 / 실제 투구 수.",
  },
  {
    label: "루킹%",
    value: (r) => percent(r.calledStrikeRate),
    sortValue: (r) => r.calledStrikeRate,
    description: "루킹 스트라이크 수 / 실제 투구 수.",
  },
  {
    label: "CSW%",
    value: (r) => percent(r.cswRate),
    sortValue: (r) => r.cswRate,
    description: "루킹 스트라이크와 헛스윙 수 / 실제 투구 수.",
    compact: true,
  },
  {
    label: "존 알려짐",
    value: (r) => r.zoneKnown,
    sortValue: (r) => r.zoneKnown,
    description: "좌표와 스트라이크존으로 존 안팎을 판정할 수 있는 실제 투구 수입니다.",
  },
  {
    label: "Zone%",
    value: (r) => percent(r.zoneRate),
    sortValue: (r) => r.zoneRate,
    description: "존 안 투구 수 / 존 판정 가능 투구 수.",
  },
  {
    label: "Chase%",
    value: (r) => percent(r.chaseRate),
    sortValue: (r) => r.chaseRate,
    description: "존 밖 스윙 수 / 존 밖 투구 수. 존 판정 가능 표본만 사용합니다.",
    compact: true,
  },
  {
    label: "2S 공",
    value: (r) => r.twoStrikePitches,
    sortValue: (r) => r.twoStrikePitches,
    description: "2스트라이크 상황의 실제 투구 수입니다.",
  },
  {
    label: "종결 K",
    value: (r) => r.terminalStrikeouts,
    sortValue: (r) => r.terminalStrikeouts,
    description: "삼진으로 타석을 끝낸 실제 투구 수입니다. 자동 스트라이크 종결은 제외합니다.",
  },
  {
    label: "결정구%",
    value: (r) => percent(r.putAwayRate),
    sortValue: (r) => r.putAwayRate,
    description: "삼진 종결 실제 투구 수 / 2스트라이크 실제 투구 수.",
    compact: true,
  },
  {
    label: "인플레이 결과",
    value: (r) => r.inPlayResults,
    sortValue: (r) => r.inPlayResults,
    description: "타석 종료 인플레이 결과와 연결된 투구 수입니다.",
  },
  {
    label: "안타 비율",
    value: (r) => percent(r.inPlayHitRate),
    sortValue: (r) => r.inPlayHitRate,
    description: "안타 결과 수 / 연결된 종결 인플레이 결과 수. 공식 타율과 분모가 다릅니다.",
  },
];

type RateSort = { column: string; direction: "ascending" | "descending" };

export function PitchRateTable({
  title,
  rows,
  controls,
}: {
  title: string;
  rows: readonly PitchRateGroup[];
  controls?: ReactNode;
}) {
  const [detailed, setDetailed] = useState(false);
  const [sort, setSort] = useState<RateSort | null>(null);
  const visible = columns.filter((column) => detailed || column.compact);
  const sortColumn = columns.find((column) => column.label === sort?.column);
  const orderedRows = useMemo(() => {
    if (!sort || !sortColumn) return rows;
    const direction = sort.direction === "descending" ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index, value: sortColumn.sortValue(row) }))
      .sort((a, b) => {
        if (a.value === null && b.value === null) return a.index - b.index;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return direction * (a.value - b.value) || a.index - b.index;
      })
      .map(({ row }) => row);
  }, [rows, sort, sortColumn]);
  return (
    <section className="panel outcome-rate-panel">
      <div className="analysis-panel-heading">
        <div>
          <span className="analysis-kicker">BREAKDOWN</span>
          <h2>{title}</h2>
        </div>
        <button
          className="analysis-button"
          aria-pressed={detailed}
          onClick={() => {
            setDetailed(!detailed);
            if (detailed && !sortColumn?.compact) setSort(null);
          }}
        >
          상세 지표
        </button>
      </div>
      {controls}
      <div className="table-scroll" tabIndex={0}>
        <table className="outcome-stat-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">구분</th>
              {visible.map((c) => (
                <th
                  scope="col"
                  key={c.label}
                  aria-sort={sort?.column === c.label ? sort.direction : "none"}
                >
                  <button
                    type="button"
                    aria-label={`${c.label} ${sort?.column === c.label && sort.direction === "descending" ? "오름차순" : "내림차순"} 정렬`}
                    onClick={() =>
                      setSort({
                        column: c.label,
                        direction:
                          sort?.column === c.label && sort.direction === "descending"
                            ? "ascending"
                            : "descending",
                      })
                    }
                  >
                    <span>{c.label}</span>
                    <span className="outcome-sort-mark" aria-hidden="true">
                      {sort?.column === c.label
                        ? sort.direction === "descending"
                          ? "↓"
                          : "↑"
                        : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orderedRows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{outcomeGroupLabel(row.key)}</th>
                {visible.map((c) => (
                  <td key={c.label}>{c.value(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="analysis-caption">이 조건에 해당하는 투구가 없습니다.</p>}
      <p className="analysis-caption">
        열 제목을 누르면 내림차순·오름차순으로 정렬합니다. 분모가 없는 비율은 —로 표시하며 정렬 시
        마지막에 둡니다.
      </p>
      <details className="outcome-metric-guide">
        <summary>지표 안내</summary>
        <dl>
          {visible.map((column) => (
            <div key={column.label}>
              <dt>{column.label}</dt>
              <dd>{column.description}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

export function PitchOutcomeBreakdown({
  data,
}: {
  data: PitchLocationResponse | BatterProfileResponse;
}) {
  const [selected, setSelected] = useState("type");
  const groups = [
    { id: "type", label: "구종별", title: "구종별 반응", rows: data.byType },
    { id: "count", label: "카운트별", title: "카운트별 반응", rows: data.byCount },
    { id: "stance", label: "타석 좌우별", title: "타석 좌우별 반응", rows: data.byStance },
    ...("batterId" in data
      ? [{ id: "speed", label: "구속대별", title: "구속대별 반응", rows: data.bySpeed }]
      : []),
  ];
  const active = groups.find((group) => group.id === selected) ?? groups[0];
  if (!active) return null;
  return (
    <PitchRateTable
      title={active.title}
      rows={active.rows}
      controls={
        <div className="analysis-segments" role="group" aria-label="비교 기준">
          {groups.map((group) => (
            <button
              key={group.id}
              aria-pressed={active.id === group.id}
              onClick={() => setSelected(group.id)}
            >
              {group.label}
            </button>
          ))}
        </div>
      }
    />
  );
}
