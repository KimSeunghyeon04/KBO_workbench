import type { PitchSequenceResponse } from "@kbo/contracts";
import { pitchPositionAtPlane, PITCH_COMPARISON_START_FEET } from "@kbo/game-core";
import { pitchCallLabel } from "../events/relay-text";
const n = (value: number | null) => value?.toFixed(2) ?? "—";
const signed = (value: number | null) => (value !== null && value > 0 ? `+${n(value)}` : n(value));

export function PitchSequenceTrajectory({
  selected,
}: {
  selected: PitchSequenceResponse["pairs"][number];
}) {
  const curves = [selected.previous, selected.current].map((row) => {
    if (row.y0 === null) return [];
    const first = Math.min(PITCH_COMPARISON_START_FEET, row.y0);
    const last = row.crossPlateY ?? 17 / 12;
    if (first <= last || pitchPositionAtPlane(row, first) === null) return [];
    return Array.from({ length: 41 }, (_, i) => {
      const y = i === 40 ? last : first - (i * (first - last)) / 40;
      const point = pitchPositionAtPlane(row, y);
      return point === null ? null : { y, ...point };
    }).filter((p) => p !== null);
  });
  const yValues = curves.flatMap((curve) => curve.map((point) => point.y));
  const minY = Math.min(23.8, ...yValues),
    maxY = Math.max(23.8, ...yValues);
  const plotX = (y: number) => 45 + ((maxY - y) / (maxY - minY || 1)) * 410;
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
        면 간격 {n(selected.planeDistanceCm)} cm · 50ft 기준 두 번째−첫 번째 시간{" "}
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
                    x1={plotX(23.8)}
                    x2={plotX(23.8)}
                    y1="20"
                    y2="200"
                    stroke="#aaa"
                    strokeDasharray="3"
                  />
                  <text x={plotX(23.8) + 5} y="16">
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
                        .map((p) => `${plotX(p.y)},${200 - ((p[axis] - min) / (max - min)) * 180}`)
                        .join(" ")}
                    />
                  ))}
                  <text x="45" y="220">
                    {n(maxY)} ft
                  </text>
                  <text x="455" y="220" textAnchor="end">
                    {n(minY)} ft
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
          홈플레이트 뒤 꼭짓점이 원점입니다. 두 공이 50피트에서 23.8피트까지 가는 데 걸린 시간을
          비교합니다. 한 공이라도 50피트에서의 궤적을 계산할 수 없으면 시간차를 비웁니다.
        </p>
      </details>
    </div>
  );
}
