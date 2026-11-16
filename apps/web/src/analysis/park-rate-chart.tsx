import { useState } from "react";
import type { ParkEnvironmentResponse } from "@kbo/contracts";
import { formatStatNumber } from "./statistics-format";
import "../styles/park-rate-chart.css";

type Metric = "runRate" | "homeRunRate" | "completeRunRate";
const labels: Record<Metric, string> = {
  runRate: "득점 / 타석",
  homeRunRate: "홈런 / 타석",
  completeRunRate: "득점 / 완결 반이닝",
};

export function ParkRateChart({ parks }: { parks: ParkEnvironmentResponse["parks"] }) {
  const [metric, setMetric] = useState<Metric>("runRate");
  const maximum = Math.max(0, ...parks.map((park) => park.total[metric] ?? 0));
  return (
    <section className="park-rate-chart" aria-label="구장별 관측 비율 비교">
      <div className="park-rate-heading">
        <div>
          <h3>어느 구장에서 득점이 많았나</h3>
          <p>홈·원정 합계 · 팀과 선수 구성 차이가 포함된 관측값입니다.</p>
        </div>
        <label>
          비교 지표
          <select
            value={metric}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "runRate" || value === "homeRunRate" || value === "completeRunRate") {
                setMetric(value);
              }
            }}
          >
            {Object.entries(labels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {parks.length === 0 ? (
        <p>선택한 범위에 구장 기록이 없습니다.</p>
      ) : (
        <>
          <div className="park-rate-axis" aria-hidden="true">
            <span>0</span>
            <span>
              {formatStatNumber(maximum)} {labels[metric]}
            </span>
          </div>
          <ul>
            {parks.map((park) => {
              const value = park.total[metric];
              return (
                <li key={park.key}>
                  <div className="park-rate-label">
                    <strong>{park.stadiums.join(" / ") || "구장 미상"}</strong>
                    <small>
                      {park.total.games}경기 ·{" "}
                      {metric === "completeRunRate"
                        ? `${park.total.completeHalves.toLocaleString()} 완결 반이닝`
                        : `${park.total.pa.toLocaleString()}타석`}
                      {park.parkId === null ? " · 시설 미확인" : ""}
                    </small>
                  </div>
                  <span className="park-rate-track" aria-hidden="true">
                    {value !== null && (
                      <i style={{ width: `${maximum === 0 ? 0 : (value / maximum) * 100}%` }} />
                    )}
                  </span>
                  <span
                    className="park-rate-value"
                    aria-label={`${labels[metric]} ${formatStatNumber(value)}`}
                  >
                    {formatStatNumber(value)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="analysis-caption">
            막대는 0에서 시작하며 모든 구장에 같은 눈금을 사용합니다. —는 비율을 계산할 표본이 없는
            경우입니다.
          </p>
          {metric === "completeRunRate" && (
            <p className="analysis-caption">
              완결 반이닝은 정상 9이닝 경기의 1–8회 중 3아웃으로 끝난 공격만 포함합니다.
            </p>
          )}
        </>
      )}
    </section>
  );
}
