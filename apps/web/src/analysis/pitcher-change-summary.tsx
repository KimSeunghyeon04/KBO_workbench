import { useState } from "react";
import type { PitcherChangesResponse } from "@kbo/contracts";
import {
  formatPitchChange,
  pitchChangeDescriptions,
  pitchChangeInterpretation,
  pitchChangeInterval,
  pitchChangeMetrics,
  type PitchChangeMetricKey,
} from "./pitch-change-metrics";
import "../styles/pitcher-changes.css";

function windowLabel(window: PitcherChangesResponse["recent"]): string {
  const first = window.games[0],
    last = window.games.at(-1);
  return first && last ? `${first.gameDate} ~ ${last.gameDate}` : "등판 자료 없음";
}

export function PitcherChangeSummary({ data }: { data: PitcherChangesResponse }) {
  const [selected, setSelected] = useState<PitchChangeMetricKey>("speedKph");
  const groups = [...data.changes]
    .sort((a, b) => {
      const count = (g: typeof a) => g.metrics.find((m) => m.metric === "usage")?.recentCount ?? 0;
      const left = a.pitchType ?? "",
        right = b.pitchType ?? "";
      return count(b) - count(a) || (left < right ? -1 : left > right ? 1 : 0);
    })
    .slice(0, 3);
  const rows = groups.flatMap((group) => {
    const metric = group.metrics.find((m) => m.metric === selected);
    return metric ? [{ pitchType: group.pitchType, metric }] : [];
  });
  const extent =
    Math.max(
      0.01,
      ...rows.flatMap(({ metric }) =>
        [metric.difference, metric.lower, metric.upper].flatMap((v) =>
          v === null ? [] : [Math.abs(v)],
        ),
      ),
    ) * 1.2;
  const x = (v: number) => 150 + (v / extent) * 130;

  return (
    <section className="panel pitch-change-summary" aria-label="변화 한눈에">
      <div className="analysis-panel-heading">
        <div>
          <h2>변화 한눈에</h2>
        </div>
        <label>
          비교 지표
          <select
            value={selected}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "speedKph" ||
                value === "usage" ||
                value === "xCm" ||
                value === "zCm" ||
                value === "arrivalMs"
              )
                setSelected(value);
            }}
          >
            {Object.entries(pitchChangeMetrics).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="pitch-change-windows">
        <p>
          <strong>최근 {data.recent.games.length}등판</strong>
          <span>{windowLabel(data.recent)}</span>
          <span>
            {data.recent.pitches.toLocaleString()}구 · 보정{" "}
            {data.recent.calibrated.toLocaleString()}구
          </span>
        </p>
        <p>
          <strong>이전 {data.previous.games.length}등판</strong>
          <span>{windowLabel(data.previous)}</span>
          <span>
            {data.previous.pitches.toLocaleString()}구 · 보정{" "}
            {data.previous.calibrated.toLocaleString()}구
          </span>
        </p>
      </div>
      <p>
        최근 투구 수가 많은 최대 3개 구종입니다. 차이는 최근−이전이며, 점은 변화량·선은 95%
        구간·가운데는 변화 0입니다.
      </p>
      {data.status !== "ready" && (
        <p role="status">
          {data.status === "ambiguous_same_day"
            ? "같은 날 등판 순서를 확인할 수 없어 비교하지 않았습니다."
            : "8등판 미만으로 확보된 기간만 표시합니다."}
        </p>
      )}
      <p className="analysis-caption">{pitchChangeDescriptions[selected]}</p>
      {selected === "usage" && (
        <p>
          사용률 분모: 최근 전체 {data.recent.pitches}구 · 이전 전체 {data.previous.pitches}구.
          차이는 %p입니다.
        </p>
      )}
      {selected !== "speedKph" && selected !== "usage" && (
        <p>
          보정이 적용된 투구만 비교합니다. 구장 보정 미지원과 좌표 누락에 따라 구속·사용률과 표본이
          다릅니다.
        </p>
      )}
      {rows.length === 0 ? (
        <p>비교할 구종 자료가 없습니다.</p>
      ) : (
        <div className="pitch-change-cards">
          {rows.map(({ pitchType, metric }) => (
            <article
              className="pitch-change-card"
              key={pitchType ?? "unknown"}
              aria-label={`${pitchType ?? "구종 미상"} ${pitchChangeMetrics[selected].label} 변화`}
            >
              <h3>{pitchType ?? "구종 미상"}</h3>
              <strong className="pitch-change-value">
                {formatPitchChange(selected, metric.difference, true)}
              </strong>
              <span className="pitch-change-status">{pitchChangeInterpretation(metric)}</span>
              <p>
                이전 {formatPitchChange(selected, metric.previous)} → 최근{" "}
                {formatPitchChange(selected, metric.recent)}
              </p>
              <svg viewBox="0 0 300 42" aria-hidden="true">
                <path d="M20 21H280 M150 5V37" className="pitch-change-axis" />
                {metric.status === "sufficient" &&
                  metric.lower !== null &&
                  metric.upper !== null && (
                    <line
                      x1={x(metric.lower)}
                      x2={x(metric.upper)}
                      y1={21}
                      y2={21}
                      className="pitch-change-interval"
                    />
                  )}
                {metric.difference !== null && (
                  <circle cx={x(metric.difference)} cy={21} r={5} className="pitch-change-point" />
                )}
              </svg>
              <p>95% 구간: {pitchChangeInterval(metric)}</p>
              <small>
                해당 구종 표본 최근 {metric.recentCount}구/{metric.recentGames}경기 · 이전{" "}
                {metric.previousCount}구/{metric.previousGames}경기
              </small>
            </article>
          ))}
        </div>
      )}
      <p className="pitch-change-reading-note">
        구간에 0이 포함되면 증가·감소 방향이 확실하지 않습니다. 변화량은 실력 향상이나 저하의 판정이
        아니며, 구장·상대·상황 구성의 영향이 포함됩니다.
      </p>
    </section>
  );
}
