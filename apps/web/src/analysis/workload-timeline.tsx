import type { PitcherWorkloadResponse } from "@kbo/contracts";
import { useId } from "react";
import "../styles/workload-timeline.css";

type Appearance = PitcherWorkloadResponse["appearances"][number];

export function WorkloadTimeline({
  appearances,
  selected,
  onSelect,
}: {
  appearances: readonly Appearance[];
  selected: Appearance | undefined;
  onSelect: (gameId: string) => void;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dated = appearances
    .map((appearance) => ({ appearance, day: Date.parse(`${appearance.gameDate}T00:00:00Z`) }))
    .filter(({ day }) => Number.isFinite(day));
  const first = Math.min(...dated.map(({ day }) => day));
  const last = Math.max(...dated.map(({ day }) => day));
  const maximum = Math.max(
    20,
    Math.ceil(Math.max(...dated.map(({ appearance }) => appearance.pitches)) / 20) * 20,
  );
  const x = (day: number) => (first === last ? 416 : 48 + ((day - first) / (last - first)) * 736);
  const y = (pitches: number) => 188 - (pitches / maximum) * 152;
  const dateLabel = (day: number) => new Date(day).toISOString().slice(5, 10).replace("-", "/");

  return (
    <section className="panel workload-timeline" aria-labelledby={headingId}>
      <div className="workload-timeline-heading">
        <h2 id={headingId}>등판별 투구 수</h2>
        <span>수집된 {appearances.length.toLocaleString()}등판</span>
      </div>
      <p id={descriptionId}>
        점 하나가 한 경기의 실제 투구 수입니다. 가로 간격은 달력 날짜이며, 빈 날짜가 실제 휴식을
        뜻하지는 않습니다.
      </p>
      {dated.length > 0 ? (
        <div
          className="workload-chart-scroll"
          tabIndex={0}
          role="region"
          aria-label="날짜별 투구 수 차트"
        >
          <svg
            viewBox="0 0 816 228"
            role="img"
            aria-labelledby={headingId}
            aria-describedby={descriptionId}
          >
            <text x={16} y={18}>
              투구 수 (구)
            </text>
            {[0, maximum / 2, maximum].map((tick) => (
              <g key={tick}>
                <line x1={48} x2={784} y1={y(tick)} y2={y(tick)} className="workload-chart-grid" />
                <text x={36} y={y(tick) + 4} textAnchor="end">
                  {tick}
                </text>
              </g>
            ))}
            {dated.map(({ appearance, day }) => (
              <g key={`${appearance.gameId}-${appearance.revision}`}>
                <title>
                  {appearance.gameDate} · {appearance.teamName} · {appearance.pitches}구
                </title>
                <line
                  x1={x(day)}
                  x2={x(day)}
                  y1={y(0)}
                  y2={y(appearance.pitches)}
                  className="workload-chart-stem"
                />
                <circle
                  cx={x(day)}
                  cy={y(appearance.pitches)}
                  r={appearance.gameId === selected?.gameId ? 6 : 4}
                  className={
                    appearance.gameId === selected?.gameId
                      ? "workload-chart-point is-selected"
                      : "workload-chart-point"
                  }
                />
              </g>
            ))}
            {Array.from(new Set([first, Math.round((first + last) / 2), last])).map((day) => (
              <text key={day} x={x(day)} y={214} textAnchor="middle">
                {dateLabel(day)}
              </text>
            ))}
          </svg>
        </div>
      ) : (
        <p>날짜별로 표시할 등판 기록이 없습니다.</p>
      )}
      {selected && (
        <>
          <label className="workload-appearance-picker">
            자세히 볼 등판
            <select value={selected.gameId} onChange={(event) => onSelect(event.target.value)}>
              {appearances.map((appearance) => (
                <option
                  key={`${appearance.gameId}-${appearance.revision}`}
                  value={appearance.gameId}
                >
                  {appearance.gameDate} · {appearance.teamName} · {appearance.pitches}구 · 기록 버전{" "}
                  {appearance.revision}
                </option>
              ))}
            </select>
          </label>
          {selected.sameDayOrder === "unknown" && (
            <p>
              같은 날 {selected.sameDayAppearances}등판이 관측되었으며 경기 순서는 미확인입니다.
              차트의 점이 겹칠 수 있습니다.
            </p>
          )}
          <dl className="workload-selected-summary">
            <div>
              <dt>선택 등판</dt>
              <dd>
                {selected.pitches}
                <small>구</small>
              </dd>
            </div>
            <div>
              <dt>이전 3일 투구</dt>
              <dd>
                {selected.previous3DaysPitches}
                <small>구</small>
              </dd>
            </div>
            <div>
              <dt>이전 7일 투구</dt>
              <dd>
                {selected.previous7DaysPitches}
                <small>구</small>
              </dd>
            </div>
            <div>
              <dt>관측 휴식일</dt>
              <dd>
                {selected.observedRestDays ?? "—"}
                {selected.observedRestDays !== null && <small>일</small>}
              </dd>
            </div>
          </dl>
          <p>
            이전 3·7일 합계에는 선택한 날짜를 포함하지 않습니다. 수집되지 않은 경기의 투구 수는 알
            수 없습니다.
          </p>
        </>
      )}
    </section>
  );
}
