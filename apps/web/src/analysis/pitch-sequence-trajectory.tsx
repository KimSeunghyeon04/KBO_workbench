import type { PitchSequenceResponse } from "@kbo/contracts";
import { pitchPositionAtPlane } from "@kbo/game-core";
import { pitchCallLabel } from "../events/relay-text";
const n = (value: number | null) => value?.toFixed(2) ?? "—";
const signed = (value: number | null) => (value !== null && value > 0 ? `+${n(value)}` : n(value));

export function PitchSequenceTrajectory({
  selected,
}: {
  selected: PitchSequenceResponse["pairs"][number];
}) {
  const curves = [selected.previous, selected.current].map((row) =>
    Array.from({ length: 41 }, (_, i) => {
      const y = 49.99 - (i * (49.99 - 1.4167)) / 40,
        point = pitchPositionAtPlane(row, y);
      return point === null ? null : { y, ...point };
    }).filter((p) => p !== null),
  );
  return (
    <div className="sequence-trajectory">
      <p>
        {pitchCallLabel(selected.previous.pitchCall)} → {pitchCallLabel(selected.current.pitchCall)}{" "}
        · 두 번째 공 {selected.current.balls}볼 {selected.current.strikes}스트라이크
      </p>
      <p className="analysis-caption">
        주황 점선: 첫 공 · 녹색 실선: 두 번째 공 · 세로 점선: 23.8ft 비교면
      </p>
      <p>
        면 간격 {n(selected.planeDistanceCm)} cm · 두 번째−첫 번째 시간{" "}
        {signed(selected.planeTimeDifferenceMs)} ms · 두 번째−첫 번째 구속{" "}
        {signed(selected.speedDifferenceKph)} km/h
      </p>
      {curves.some((curve) => curve.length === 0) ? (
        <p role="status">
          두 공 모두의 원천 궤적이 있어야 비교 차트를 표시합니다. 일부 좌표가 누락되어 이 쌍의
          궤적을 비교할 수 없습니다.
        </p>
      ) : (
        <div className="sequence-trajectory-plots">
          {(["xCm", "zCm"] as const).map((axis) => {
            const values = curves.flatMap((c) => c.map((p) => p[axis])),
              min = Math.min(-10, ...values) - 10,
              max = Math.max(10, ...values) + 10;
            return (
              <figure key={axis}>
                <figcaption>
                  {axis === "xCm" ? "수평 위치" : "높이"} · 세로 cm / 가로 y ft
                </figcaption>
                <svg
                  viewBox="0 0 500 230"
                  style={{ width: "100%", maxWidth: 650 }}
                  role="img"
                  aria-label={axis === "xCm" ? "수평 궤적 비교" : "높이 궤적 비교"}
                >
                  <text x="4" y="16">
                    {n(max)}
                  </text>
                  <text x="4" y="200">
                    {n(min)}
                  </text>
                  <line
                    x1={45 + (50 - 23.8) * 8.5}
                    x2={45 + (50 - 23.8) * 8.5}
                    y1="20"
                    y2="200"
                    stroke="#aaa"
                    strokeDasharray="3"
                  />
                  <text x={45 + (50 - 23.8) * 8.5 + 5} y="16">
                    23.8 ft
                  </text>
                  {curves.map((c, i) => (
                    <polyline
                      key={i}
                      fill="none"
                      stroke={i === 0 ? "#bc6220" : "#18794e"}
                      strokeWidth="3"
                      strokeDasharray={i === 0 ? "7 4" : undefined}
                      points={c
                        .map(
                          (p) =>
                            `${45 + (50 - p.y) * 8.5},${200 - ((p[axis] - min) / (max - min)) * 180}`,
                        )
                        .join(" ")}
                    />
                  ))}
                  <text x="45" y="220">
                    50 ft
                  </text>
                  <text x="395" y="220">
                    1.42 ft
                  </text>
                </svg>
              </figure>
            );
          })}
        </div>
      )}
      <details className="analysis-caption">
        <summary>좌표와 해석 기준</summary>{" "}
        <p>
          홈플레이트 뒤 꼭짓점 원점, y=23.8ft 비교면. 주황 점선: 첫 공, 녹색 실선: 두 번째 공. 원천
          모델의 기하 비교이며 타자의 인식 시점이나 최적 배합 점수가 아닙니다. 끝점 구장 보정을 중간
          궤적에 적용하지 않습니다.
        </p>
      </details>
    </div>
  );
}
