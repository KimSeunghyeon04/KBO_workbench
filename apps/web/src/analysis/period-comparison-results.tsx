import { useState } from "react";
import type { PeriodMetric, PeriodSnapshot } from "@kbo/contracts";
import { formatPeriodValue } from "./period-value";

export function PeriodComparisonResults({
  data,
  defaultMetric,
}: {
  data: {
    first: PeriodSnapshot;
    second: PeriodSnapshot;
    metrics: PeriodMetric[];
    warnings: string[];
  };
  defaultMetric: string;
}) {
  const labels = [...new Set(data.metrics.map((row) => row.label))];
  const [metric, setMetric] = useState(
    labels.includes(defaultMetric) ? defaultMetric : (labels[0] ?? ""),
  );
  const [group, setGroup] = useState(
    data.metrics.some((row) => row.group === "전체") ? "전체" : "",
  );
  const groups = [...new Set(data.metrics.map((row) => row.group))];
  const rows = data.metrics.filter((row) => group === "" || row.group === group);
  const availableLabels = [...new Set(rows.map((row) => row.label))];
  const activeMetric = availableLabels.includes(metric) ? metric : (availableLabels[0] ?? "");
  const chart = rows.filter((row) => row.label === activeMetric).slice(0, 12);
  const values = chart.flatMap((row) =>
    [row.first.value, row.second.value].filter((v): v is number => v !== null),
  );
  const unit = chart[0]?.unit ?? "number";
  const lo =
    unit === "rate"
      ? values.some((value) => value < 0)
        ? -1
        : 0
      : Math.floor(Math.min(0, ...values));
  const hi = unit === "rate" ? 1 : Math.max(1, Math.ceil(Math.max(0, ...values) * 1.05));
  const x = (v: number) => 160 + ((v - lo) / (hi - lo)) * 340;
  return (
    <div className="period-results">
      <div className="location-period-fields">
        {([data.first, data.second] as const).map((p, i) => (
          <section
            key={i}
            className="period-snapshot"
            aria-label={`기간 ${i === 0 ? "A" : "B"} 표본`}
          >
            <h3>
              기간 {i === 0 ? "A" : "B"} · {p.scope.season}
            </h3>
            <p>
              {p.scope.dateFrom ?? "시즌 시작"} ~ {p.scope.dateTo ?? "시즌 끝"}
            </p>
            <ul>
              {p.samples.map((s) => (
                <li key={s.label}>
                  {s.label} <strong>{s.count.toLocaleString()}</strong>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {data.warnings.map((w) => (
        <p key={w} className="analysis-caption" role="note">
          {w}
        </p>
      ))}
      {data.metrics.length === 0 && <p role="status">두 기간에 비교할 표본이 없습니다.</p>}
      {data.metrics.length > 0 && (
        <>
          <div className="period-result-controls">
            <label>
              비교 그룹
              <select
                aria-label="기간 비교 그룹"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="">전체 그룹</option>
                {groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              차트 지표
              <select
                aria-label="기간 비교 차트 지표"
                value={activeMetric}
                onChange={(e) => setMetric(e.target.value)}
              >
                {availableLabels.map((label) => (
                  <option key={label}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          {chart.length > 0 && (
            <figure className="period-metric-chart">
              <figcaption>
                {activeMetric} · A ○ / B ◆ · 공통 축 {formatPeriodValue(lo, unit)} ~{" "}
                {formatPeriodValue(hi, unit)}
              </figcaption>
              <svg
                viewBox={`0 0 600 ${chart.length * 42 + 34}`}
                role="img"
                aria-label={`${activeMetric} 기간 A B 비교 차트`}
              >
                {chart.map((row, i) => {
                  const y = 26 + i * 42;
                  return (
                    <g key={row.key}>
                      <text x="0" y={y + 4}>
                        {row.group}
                      </text>
                      <line x1="160" y1={y} x2="500" y2={y} stroke="var(--ui-line)" />
                      {row.difference !== null &&
                        row.first.value !== null &&
                        row.second.value !== null && (
                          <line
                            x1={x(row.first.value)}
                            y1={y}
                            x2={x(row.second.value)}
                            y2={y}
                            stroke="var(--ui-muted)"
                            strokeWidth="2"
                          />
                        )}
                      {row.first.value !== null && (
                        <circle
                          cx={x(row.first.value)}
                          cy={y}
                          r="5"
                          fill="white"
                          stroke="#766c5d"
                          strokeWidth="2"
                        />
                      )}
                      {row.second.value !== null && (
                        <path
                          d={`M ${x(row.second.value)} ${y - 6} l 6 6 l -6 6 l -6 -6 Z`}
                          fill="#176b57"
                        />
                      )}
                      <text x="510" y={y + 4}>
                        {formatPeriodValue(row.difference, row.unit, true)}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <p className="analysis-caption">
                정확한 값과 표본은 아래 표에서 확인하세요. 차트는 최대 12개 그룹을 표시합니다.
              </p>
            </figure>
          )}
          <div className="table-scroll" tabIndex={0}>
            <table aria-label="두 기간 지표 비교">
              <thead>
                <tr>
                  <th>그룹</th>
                  <th>지표</th>
                  <th>기간 A</th>
                  <th>기간 B</th>
                  <th>차이 B−A</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.group}</th>
                    <td>{row.label}</td>
                    {[row.first, row.second].map((o, i) => (
                      <td key={i}>
                        {formatPeriodValue(o.value, row.unit)}
                        {o.denominator !== null && (
                          <small className="period-denominator">
                            {o.numerator === null
                              ? `표본 ${o.denominator}`
                              : `${o.numerator}/${o.denominator}`}
                            {row.unit === "rate" && o.denominator > 0 && o.denominator < 20
                              ? " · 소표본"
                              : ""}
                          </small>
                        )}
                      </td>
                    ))}
                    <td>{formatPeriodValue(row.difference, row.unit, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <details className="analysis-disclosure">
        <summary>비교 기준과 원천 해시</summary>
        <p>
          미확인 값·분모 0은 —입니다. 비율 차이는 %p이며 관측 차이를 인과 효과나 확정된 기량 변화로
          해석하지 않습니다.
        </p>
        <p>
          원천 A <code>{data.first.sourceHash}</code>
        </p>
        <p>
          원천 B <code>{data.second.sourceHash}</code>
        </p>
      </details>
    </div>
  );
}
