import { useState } from "react";
import { Link } from "react-router-dom";
import type { PitchRateGroup, PitchLocationPoint, BatterProfileResponse } from "@kbo/contracts";
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
export function PitchRateTable({ title, rows }: { title: string; rows: PitchRateGroup[] }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label={title}>
          <thead>
            <tr>
              {[
                "구분",
                "공",
                "스윙",
                "헛스윙",
                "Swing%",
                "Whiff%",
                "Contact%",
                "SwStr%",
                "루킹%",
                "CSW%",
                "존 알려짐",
                "Zone%",
                "Chase%",
                "2S 공",
                "종결 K",
                "결정구%",
                "인플레이 결과",
                "안타 비율",
              ].map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.key}>
                <th>{g.key}</th>
                <td>{g.pitches}</td>
                <td>{g.swings}</td>
                <td>{g.whiffs}</td>
                <td>{percent(g.swingRate)}</td>
                <td>{percent(g.whiffRate)}</td>
                <td>{percent(g.whiffRate === null ? null : 1 - g.whiffRate)}</td>
                <td>{percent(g.swingingStrikeRate)}</td>
                <td>{percent(g.calledStrikeRate)}</td>
                <td>{percent(g.cswRate)}</td>
                <td>{g.zoneKnown}</td>
                <td>{percent(g.zoneRate)}</td>
                <td>{percent(g.chaseRate)}</td>
                <td>{g.twoStrikePitches}</td>
                <td>{g.terminalStrikeouts}</td>
                <td>{percent(g.putAwayRate)}</td>
                <td>{g.inPlayResults}</td>
                <td>{percent(g.inPlayHitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Whiff%는 스윙, SwStr%·CSW%는 실제 투구가 분모입니다. 결정구%는 2스트라이크 실제 투구 중 삼진
        종결 비율입니다. 인플레이 안타 비율은 연결된 종결 인플레이 결과가 분모입니다.
      </p>
    </section>
  );
}
export function PitchLocationMap({
  cells,
  points,
}: {
  cells: PitchRateGroup[];
  points: PitchLocationPoint[];
}) {
  const [cell, setCell] = useState<number | null>(null),
    [page, setPage] = useState(0);
  const selected = points.filter((p) => cell === null || p.cell === cell);
  return (
    <section className="panel">
      <h2>5×5 실제 코스</h2>
      <p>
        포수 시점 · 위쪽이 높은 공입니다. 바깥 칸은 존 밖 전체를 포함합니다. 지도 수치는 스윙 중
        헛스윙 비율이며, 20스윙 미만은 소표본으로 표시합니다.
      </p>
      <div className="discipline-map" aria-label="실제 코스 지도">
        {Array.from({ length: 25 }, (_, i) => Math.floor((24 - i) / 5) * 5 + (i % 5)).map(
          (index) => {
            const g = cells[index];
            return g === undefined ? null : (
              <button
                key={index}
                aria-label={`코스 ${index}: ${g.pitches}구`}
                aria-pressed={cell === index}
                onClick={() => {
                  setCell(index);
                  setPage(0);
                }}
                style={{
                  background:
                    g.swings < 20 ? "#f2f4f2" : `rgba(24,121,78,${0.1 + 0.6 * (g.whiffRate ?? 0)})`,
                }}
              >
                <strong>{percent(g.whiffRate)}</strong>
                <small>
                  {g.pitches}구 / {g.swings}스윙
                </small>
                <small>{g.swings < 20 ? "소표본" : ""}</small>
              </button>
            );
          },
        )}
      </div>
      <button
        onClick={() => {
          setCell(null);
          setPage(0);
        }}
      >
        모든 코스
      </button>
      <p>
        선택 근거 {selected.length}구 · 원천 도착면, 신장 기준 존. 중간면 구질 보정은 적용하지
        않습니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label="코스 투구 근거">
          <thead>
            <tr>
              {["날짜", "투구", "구종", "카운트", "구속 km/h", "x / z cm", "결과", "기록"].map(
                (s) => (
                  <th key={s}>{s}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {selected.slice(page * 20, page * 20 + 20).map((p) => (
              <tr key={JSON.stringify([p.gameId, p.revision, p.pitchId])}>
                <td>{p.gameDate}</td>
                <td>{p.pitchId}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        이전
      </button>
      <span>
        {" "}
        {page + 1} / {Math.max(1, Math.ceil(selected.length / 20))}{" "}
      </span>
      <button disabled={(page + 1) * 20 >= selected.length} onClick={() => setPage(page + 1)}>
        다음
      </button>
    </section>
  );
}
export function TerminalBattingPanel({
  data,
}: {
  data: BatterProfileResponse["plateAppearances"];
}) {
  const [type, setType] = useState<string | null>(null),
    [page, setPage] = useState(0);
  const rows = data.rows.filter((r) => type === null || r.terminalType === type);
  return (
    <section className="panel">
      <h2>종결 구종 기준 타석 성적</h2>
      <p>
        기간 내 공식 타석 {data.total.pa} · AB {data.total.ab} · 미귀속 {data.unattributed} · 미완료{" "}
        {data.partial}. 이 표에는 위 투구 조건을 적용하지 않습니다. 자동 판정·무투구 결과·책임
        타자와 종결 타자가 다른 결과는 미귀속에 보존합니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label="종결 구종 성적">
          <thead>
            <tr>
              {["종결 구종", "PA", "AB", "H", "TB", "BB", "K", "HBP", "HR", "AVG", "SLG"].map(
                (s) => (
                  <th key={s}>{s}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {[data.total, ...data.byTerminalType].map((g) => (
              <tr key={g.key}>
                <th>
                  <button
                    onClick={() => {
                      setType(g.key === "all" ? null : g.key);
                      setPage(0);
                    }}
                  >
                    {g.key === "all" ? "전체" : g.key}
                  </button>
                </th>
                <td>{g.pa}</td>
                <td>{g.ab}</td>
                <td>{g.hits}</td>
                <td>{g.totalBases}</td>
                <td>{g.walks}</td>
                <td>{g.strikeouts}</td>
                <td>{g.hitByPitch}</td>
                <td>{g.homeRuns}</td>
                <td>{g.avg?.toFixed(3) ?? "—"}</td>
                <td>{g.slg?.toFixed(3) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>선택 타석 {rows.length}개</p>
      <ul>
        {rows.slice(page * 20, page * 20 + 20).map((r) => (
          <li key={JSON.stringify([r.gameId, r.revision, r.paId])}>
            <Link
              to={`/replay?${new URLSearchParams({ gameId: r.gameId, revision: String(r.revision) })}`}
            >
              {r.gameDate} · {r.paId} · {r.result} · r{r.revision}
            </Link>
          </li>
        ))}
      </ul>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        이전 타석
      </button>
      <button disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(page + 1)}>
        다음 타석
      </button>
    </section>
  );
}
