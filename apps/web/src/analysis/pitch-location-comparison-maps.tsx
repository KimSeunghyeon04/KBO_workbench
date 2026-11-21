import { useState } from "react";
import { Link } from "react-router-dom";
import type { PitchLocationComparisonResponse } from "@kbo/contracts";
import { PitchLocationGrid } from "./pitch-location-grid";
import { outcomePercent } from "./pitch-outcome-presentation";
import { SampleRate } from "./sample-rate";
import { PeriodComparisonResults } from "./period-comparison-results";

const metrics = {
  usageRate: { label: "투구 사용 비중", maximum: 0.2, unit: "구", scale: "0 → 20%+" },
  whiffRate: { label: "헛스윙률 Whiff%", maximum: 0.5, unit: "스윙", scale: "0 → 50%+" },
  cswRate: { label: "루킹 + 헛스윙 CSW%", maximum: 0.5, unit: "구", scale: "0 → 50%+" },
  inPlayHitRate: { label: "인플레이 안타 비율", maximum: 1, unit: "결과", scale: "0 → 100%" },
};
type Metric = keyof typeof metrics;
type Period = PitchLocationComparisonResponse["first"];
function displayCell(period: Period, index: number, metric: Metric) {
  const cell = period.cells[index];
  if (cell === undefined) throw new Error("Missing location cell");
  const [numerator, denominator] =
    metric === "usageRate"
      ? [cell.pitches, period.coverage.locationPitches]
      : metric === "whiffRate"
        ? [cell.whiffs, cell.swings]
        : metric === "cswRate"
          ? [cell.csw, cell.pitches]
          : [cell.inPlayHits, cell.inPlayResults];
  return {
    value: cell[metric],
    numerator,
    denominator,
    pitches: cell.pitches,
    unit: metrics[metric].unit,
  };
}
function periodLabel(period: Period) {
  return `${period.scope.season} · ${period.scope.dateFrom ?? "시즌 시작"} ~ ${period.scope.dateTo ?? "시즌 끝"}`;
}
function periodHref(data: PitchLocationComparisonResponse, period: Period, cell: number) {
  const params = new URLSearchParams(
    Object.entries(period.query).map(([key, value]) => [key, String(value)]),
  );
  params.set("pitcher", data.pitcherId);
  params.set("locationCell", String(cell));
  return `/analysis/pitch-location?${params}`;
}

export function PitchLocationComparisonMaps({ data }: { data: PitchLocationComparisonResponse }) {
  const [metric, setMetric] = useState<Metric>("usageRate");
  const [selected, setSelected] = useState(12);
  const definition = metrics[metric];
  const difference = data.differences[selected]?.[metric] ?? null;
  const differentZone = data.first.scope.season <= 2024 !== data.second.scope.season <= 2024;
  return (
    <div className="location-comparison-results">
      <PeriodComparisonResults
        defaultMetric="Whiff%"
        data={{
          first: {
            scope: data.first.scope,
            sourceHash: data.first.sourceHash,
            samples: [{ label: "실제 투구", count: data.first.total.pitches }],
          },
          second: {
            scope: data.second.scope,
            sourceHash: data.second.sourceHash,
            samples: [{ label: "실제 투구", count: data.second.total.pitches }],
          },
          metrics: data.metrics,
          warnings: [],
        }}
      />
      <div className="location-comparison-toolbar">
        <label>
          지도 지표
          <select
            aria-label="지도 지표"
            value={metric}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "usageRate" ||
                value === "whiffRate" ||
                value === "cswRate" ||
                value === "inPlayHitRate"
              )
                setMetric(value);
            }}
          >
            {Object.entries(metrics).map(([key, item]) => (
              <option key={key} value={key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <p className="analysis-caption">포수 시점 · 같은 5 × 5 구역 · 두 지도 공통 색상 눈금</p>
      </div>
      <div className="location-comparison-maps">
        {([data.first, data.second] as const).map((period, index) => (
          <section key={index} aria-label={`기간 ${index === 0 ? "A" : "B"} 코스 비교`}>
            <h3>기간 {index === 0 ? "A" : "B"}</h3>
            <p className="location-period-label">{periodLabel(period)}</p>
            <p className="analysis-caption">
              실제 투구 {period.total.pitches.toLocaleString()}구 · 지도{" "}
              {period.coverage.locationPitches.toLocaleString()}구 · 좌표·존 미확인{" "}
              {period.coverage.missingLocation.toLocaleString()}구
            </p>
            {period.coverage.excludedSituations > 0 && (
              <p className="analysis-caption">
                선구안 상황 제외 {period.coverage.excludedSituations.toLocaleString()}구
              </p>
            )}
            {period.coverage.locationPitches === 0 && (
              <p role="status">이 기간에는 지도를 비교할 위치 표본이 없습니다.</p>
            )}
            <div className="outcome-zone-figure">
              <span className="outcome-zone-axis">높은 공</span>
              <PitchLocationGrid
                label={`기간 ${index === 0 ? "A" : "B"} 코스 지도`}
                cells={period.cells.map((_, cell) => displayCell(period, cell, metric))}
                maximum={definition.maximum}
                selected={selected}
                onSelect={setSelected}
              />
              <div className="outcome-home-plate" aria-hidden="true" />
            </div>
          </section>
        ))}
      </div>
      <div className="outcome-zone-legend">
        <span>{definition.label}</span>
        <i />
        <span>{definition.scale}</span>
      </div>
      <p className="analysis-caption">
        사용 비중은 각 기간의 위치 확인 투구, Whiff%는 각 구역의 스윙, CSW%는 각 구역의 실제 투구,
        인플레이 안타 비율은 연결된 종결 인플레이 결과가 분모입니다. 회색은 해당 분모 20 미만이며,
        —는 분모 없음입니다. 바깥 칸은 존 밖 전체를 포함합니다.
      </p>
      {differentZone && (
        <p className="outcome-sample-notice" role="note">
          두 시즌의 분석용 존 규칙이 다릅니다(2024 규칙 / 2025 규칙). 구역 구성 차이가 포함되므로
          순수한 코스 변화로 단정할 수 없습니다.
        </p>
      )}
      <div className="location-comparison-readout" aria-live="polite">
        <h3>
          선택 코스 {selected} · {definition.label}
        </h3>
        <div className="location-comparison-values">
          {([data.first, data.second] as const).map((period, index) => {
            const cell = displayCell(period, selected, metric);
            return (
              <div key={index}>
                <strong>기간 {index === 0 ? "A" : "B"}</strong>
                <SampleRate
                  value={cell.value}
                  numerator={cell.numerator}
                  denominator={cell.denominator}
                  unit={cell.unit}
                />
                <Link to={periodHref(data, period, selected)}>이 기간 코스·투구 근거 보기</Link>
              </div>
            );
          })}
          <div>
            <strong>차이 · B − A</strong>
            <span className="location-comparison-difference">
              {difference === null
                ? "—"
                : `${difference > 0 ? "+" : ""}${(difference * 100).toFixed(1)}%p`}
            </span>
          </div>
        </div>
      </div>
      <p className="analysis-caption">
        관측 비율의 비교이며 상대 타자·구장 구성 차이를 조정한 효과나 제구력 점수가 아닙니다.
        인플레이 안타 비율은 타율·BABIP와 다른 지표이며, 작은 표본의 차이를 기량 변화로 확정하지
        않습니다.
      </p>
      <details className="analysis-disclosure">
        <summary>25개 코스의 정확한 비교값</summary>
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="기간별 코스 비교 수치">
            <thead>
              <tr>
                <th scope="col">코스</th>
                <th scope="col">기간 A</th>
                <th scope="col">기간 B</th>
                <th scope="col">차이 B − A</th>
              </tr>
            </thead>
            <tbody>
              {data.differences.map((row) => {
                const a = displayCell(data.first, row.cell, metric),
                  b = displayCell(data.second, row.cell, metric);
                const delta = row[metric];
                return (
                  <tr key={row.cell}>
                    <th scope="row">{row.cell}</th>
                    <td>
                      {outcomePercent(a.value)} · {a.numerator}/{a.denominator} {a.unit}
                    </td>
                    <td>
                      {outcomePercent(b.value)} · {b.numerator}/{b.denominator} {b.unit}
                    </td>
                    <td>
                      {delta === null
                        ? "—"
                        : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%p`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
