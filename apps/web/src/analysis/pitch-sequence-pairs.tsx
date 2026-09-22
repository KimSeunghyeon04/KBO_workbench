import { useState } from "react";
import { Link } from "react-router-dom";
import type { PitchSequenceResponse } from "@kbo/contracts";
import { pitchPositionAtPlane } from "@kbo/game-core";
const n = (v: number | null) => v?.toFixed(2) ?? "—";
export function PitchSequencePairs({ data }: { data: PitchSequenceResponse }) {
  const [group, setGroup] = useState<string | null>(null),
    [page, setPage] = useState(0),
    [index, setIndex] = useState(0);
  const pairs = data.pairs.filter(
      (p) =>
        group === null || JSON.stringify([p.previous.pitchType, p.current.pitchType]) === group,
    ),
    selected = pairs[index];
  const curves =
    selected === undefined
      ? []
      : [selected.previous, selected.current].map((row) =>
          Array.from({ length: 41 }, (_, i) => {
            const y = 49.99 - (i * (49.99 - 1.4167)) / 40,
              point = pitchPositionAtPlane(row, y);
            return point === null ? null : { y, ...point };
          }).filter((p) => p !== null),
        );
  return (
    <>
      <section className="panel">
        <h2>두 구종 조합</h2>
        <p>
          성과의 분모는 두 번째 공입니다. 순서나 상대·상황 구성의 영향이 포함된 관측 결과입니다.
        </p>
        <button
          onClick={() => {
            setGroup(null);
            setPage(0);
            setIndex(0);
          }}
        >
          전체 조합
        </button>
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="두 구종 조합">
            <thead>
              <tr>
                {[
                  "조합",
                  "쌍",
                  "스윙",
                  "헛스윙",
                  "Swing%",
                  "Whiff%",
                  "루킹%",
                  "기하 쌍",
                  "면 간격 cm",
                  "도달 시간차 ms",
                  "구속 차 km/h",
                  "도착 코스 차 cm",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => {
                const pair = data.pairs.find(
                  (p) => JSON.stringify([p.previous.pitchType, p.current.pitchType]) === g.key,
                );
                return (
                  <tr key={g.key}>
                    <th>
                      <button
                        onClick={() => {
                          setGroup(g.key);
                          setPage(0);
                          setIndex(0);
                        }}
                      >
                        {pair?.previous.pitchType ?? "미상"} → {pair?.current.pitchType ?? "미상"}
                      </button>
                    </th>
                    <td>{g.pairs}</td>
                    <td>{g.swings}</td>
                    <td>{g.whiffs}</td>
                    <td>{n(g.swingRate === null ? null : g.swingRate * 100)}</td>
                    <td>{n(g.whiffRate === null ? null : g.whiffRate * 100)}</td>
                    <td>{n(g.calledStrikeRate === null ? null : g.calledStrikeRate * 100)}</td>
                    <td>{g.geometryPairs}</td>
                    <td>{n(g.meanPlaneDistanceCm)}</td>
                    <td>{n(g.meanPlaneTimeDifferenceMs)}</td>
                    <td>{n(g.meanSpeedDifferenceKph)}</td>
                    <td>{n(g.meanArrivalDistanceCm)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>선택 조합의 투구 근거</h2>
        <p>{pairs.length}쌍</p>
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="배합 투구 근거">
            <thead>
              <tr>
                {[
                  "날짜",
                  "첫 공 → 두 번째 공",
                  "첫 결과",
                  "두 번째 카운트",
                  "두 번째 결과",
                  "비교",
                  "경기",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pairs.slice(page * 20, page * 20 + 20).map((p, i) => (
                <tr key={JSON.stringify([p.current.gameId, p.current.revision, p.current.pitchId])}>
                  <td>{p.current.gameDate}</td>
                  <td>
                    {p.previous.pitchId} → {p.current.pitchId}
                  </td>
                  <td>{p.previous.pitchCall}</td>
                  <td>
                    {p.current.balls}-{p.current.strikes}
                  </td>
                  <td>{p.current.pitchCall}</td>
                  <td>
                    <button onClick={() => setIndex(page * 20 + i)}>궤적 비교</button>
                  </td>
                  <td>
                    <Link
                      to={`/replay?${new URLSearchParams({ gameId: p.current.gameId, revision: String(p.current.revision) })}`}
                    >
                      재생 r{p.current.revision}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          이전
        </button>
        <button disabled={(page + 1) * 20 >= pairs.length} onClick={() => setPage(page + 1)}>
          다음
        </button>
        {selected && (
          <>
            <h3>
              {selected.current.gameDate} · {selected.current.stadium ?? "구장 미상"} ·{" "}
              {selected.previous.pitchId} → {selected.current.pitchId}
            </h3>
            <p>
              홈플레이트 뒤 꼭짓점 원점, y=23.8ft 비교면. 주황: 첫 공, 녹색: 두 번째 공. 원천 모델의
              기하 비교이며 타자의 인식 시점이나 최적 배합 점수가 아닙니다. 끝점 구장 보정을 중간
              궤적에 적용하지 않습니다.
            </p>
            <p>
              면 간격 {n(selected.planeDistanceCm)} cm · 두 번째−첫 번째 시간{" "}
              {n(selected.planeTimeDifferenceMs)} ms · 구속 {n(selected.speedDifferenceKph)} km/h
            </p>
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
                    {curves.map((c, i) => (
                      <polyline
                        key={i}
                        fill="none"
                        stroke={i === 0 ? "#bc6220" : "#18794e"}
                        strokeWidth="3"
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
          </>
        )}
      </section>
    </>
  );
}
