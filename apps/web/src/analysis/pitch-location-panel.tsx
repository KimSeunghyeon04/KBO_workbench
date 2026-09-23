import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { PitchRateGroup, PitchLocationPoint } from "@kbo/contracts";
import { outcomePercent as percent } from "./pitch-outcome-presentation";

const cellOrder = Array.from({ length: 25 }, (_, i) => Math.floor((24 - i) / 5) * 5 + (i % 5));

export function PitchLocationMap({
  cells,
  points,
}: {
  cells: PitchRateGroup[];
  points: PitchLocationPoint[];
}) {
  const [cell, setCell] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const selected = useMemo(
    () => (cell === null ? points : points.filter((p) => p.cell === cell)),
    [points, cell],
  );
  const group = cell === null ? undefined : cells[cell];
  return (
    <section className="panel outcome-location-panel">
      <div className="analysis-panel-heading">
        <div>
          <span className="analysis-kicker">PITCH LOCATION</span>
          <h2>코스별 헛스윙</h2>
        </div>
        <span className="analysis-context-tag">포수 시점 · 5 × 5</span>
      </div>
      <div className="outcome-location-layout">
        <div className="outcome-zone-figure">
          <span className="outcome-zone-axis">높은 공</span>
          <div className="outcome-zone-grid" aria-label="실제 코스 지도">
            {cellOrder.map((index) => {
              const g = cells[index];
              if (!g) return null;
              const small = g.swings < 20;
              const intensity = Math.min(1, (g.whiffRate ?? 0) / 0.5);
              const lightness = 95 - 60 * intensity;
              return (
                <button
                  key={index}
                  aria-label={`코스 ${index}: ${g.pitches}구`}
                  aria-pressed={cell === index}
                  className={small ? "small-sample" : undefined}
                  onClick={() => {
                    setCell(index);
                    setPage(0);
                  }}
                  style={
                    small
                      ? undefined
                      : {
                          background: `hsl(164 40% ${lightness}%)`,
                          // This boundary keeps both text colors above 4.5:1 on the fixed scale.
                          color: lightness < 36.5 ? "#fff" : "#000",
                        }
                  }
                >
                  <strong>{percent(g.whiffRate)}</strong>
                  <small>{g.pitches.toLocaleString()}구</small>
                  {small && (
                    <span className="outcome-sample-dot" title="20스윙 미만">
                      ·
                    </span>
                  )}
                </button>
              );
            })}
            <div className="outcome-zone-outline" aria-hidden="true" />
          </div>
          <div className="outcome-home-plate" aria-hidden="true" />
          <div className="outcome-zone-legend">
            <span>헛스윙률</span>
            <i />
            <span>0 → 50%+</span>
          </div>
          <p className="analysis-caption">회색 칸은 20스윙 미만 · 바깥 칸은 존 밖 전체</p>
        </div>
        <aside className="outcome-zone-readout" aria-label="선택 코스 요약">
          <span className="analysis-kicker">{group ? "SELECTED ZONE" : "EXPLORE THE ZONE"}</span>
          <h3>{group ? `코스 ${cell}` : "코스를 선택해 비교하세요"}</h3>
          <p>
            {group
              ? "선택한 영역에 도착한 투구의 결과입니다."
              : "각 칸은 스윙 중 헛스윙 비율입니다. 진할수록 헛스윙 비율이 높습니다."}
          </p>
          {group ? (
            <>
              <div className="outcome-selected-rate">
                <strong>{percent(group.whiffRate)}</strong>
                <span>헛스윙률</span>
              </div>
              <dl className="outcome-zone-stats">
                <div>
                  <dt>투구</dt>
                  <dd>{group.pitches.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>스윙</dt>
                  <dd>{group.swings.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>헛스윙</dt>
                  <dd>{group.whiffs.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>CSW%</dt>
                  <dd>{percent(group.cswRate)}</dd>
                </div>
              </dl>
              {group.swings < 20 && (
                <p className="outcome-sample-notice">20스윙 미만의 소표본입니다.</p>
              )}
            </>
          ) : (
            <div className="outcome-selected-rate">
              <strong>{points.length.toLocaleString()}</strong>
              <span>위치가 확인된 투구</span>
            </div>
          )}
          <button
            className="analysis-button"
            aria-pressed={cell === null}
            onClick={() => {
              setCell(null);
              setPage(0);
            }}
          >
            모든 코스
          </button>
          <p className="analysis-caption">
            선택 근거 {selected.length}구 · 원천 도착면, 신장 기준 존. 중간면 구질 보정은 적용하지
            않습니다.
          </p>
        </aside>
      </div>
      <details className="analysis-evidence">
        <summary>투구 기록 보기 · {selected.length.toLocaleString()}구</summary>
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="코스 투구 근거">
            <thead>
              <tr>
                {["날짜", "구종", "카운트", "km/h", "x / z cm", "결과", "기록", "투구 ID"].map(
                  (s) => (
                    <th scope="col" key={s}>
                      {s}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {selected.slice(page * 20, page * 20 + 20).map((p) => (
                <tr key={JSON.stringify([p.gameId, p.revision, p.pitchId])}>
                  <td>{p.gameDate}</td>
                  <td>{p.pitchType ?? "미상"}</td>
                  <td>
                    {p.balls}-{p.strikes}
                  </td>
                  <td>{p.speedKph?.toFixed(1) ?? "—"}</td>
                  <td>
                    {p.xCm.toFixed(1)} / {p.zCm.toFixed(1)}
                  </td>
                  <td>{p.whiff ? "헛스윙" : p.swing ? "컨택" : "지켜봄"}</td>
                  <td>
                    <Link
                      to={`/replay?${new URLSearchParams({ gameId: p.gameId, revision: String(p.revision) })}`}
                    >
                      경기 재생 r{p.revision}
                    </Link>
                  </td>
                  <td>
                    <details className="outcome-pitch-id">
                      <summary>ID</summary>
                      <code>{p.pitchId}</code>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected.length === 0 && (
          <p className="analysis-caption">이 코스에 해당하는 투구가 없습니다.</p>
        )}
        <div className="analysis-pagination">
          <button
            className="analysis-button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            이전
          </button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(selected.length / 20))}
          </span>
          <button
            className="analysis-button"
            disabled={(page + 1) * 20 >= selected.length}
            onClick={() => setPage(page + 1)}
          >
            다음
          </button>
        </div>
      </details>
    </section>
  );
}
