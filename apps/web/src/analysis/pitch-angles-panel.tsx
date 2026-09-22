import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { AnalysisScopeQuery, PitchAnglesResponse } from "@kbo/contracts";
import { getPitchAngles } from "../api/pitch-angles-client";
const number = (value: number | null) => (value === null ? "—" : value.toFixed(2));
export function PitchAnglesPanel({
  pitcherId,
  query,
}: {
  pitcherId: string;
  query: AnalysisScopeQuery;
}) {
  const [open, setOpen] = useState(false),
    result = useQuery({
      queryKey: ["pitch-angles", pitcherId, query],
      queryFn: ({ signal }) => getPitchAngles(pitcherId, query, signal),
      enabled: open,
    });
  return (
    <section className="panel" aria-label="원천 궤적 진입각">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        진입각 VAA/HAA {open ? "접기" : "보기"}
      </button>
      {open && (
        <>
          <p>
            완료 경기의 원천 궤적에서 플레이트 중간면 진입각을 계산합니다. VAA 음수는 하강, HAA
            양수는 원천 X축의 양의 방향입니다. 구장 보정과 초기 방향 정렬을 적용하지 않았습니다.
            도착 높이·가로 위치와 함께 비교해야 하며 릴리스 각도나 장비의 실측 각도는 아닙니다.
          </p>
          {result.isPending && <p role="status">진입각을 계산하고 있습니다.</p>}
          {result.error && <p role="alert">{result.error.message}</p>}
          {result.data && <AnglesResult key={result.data.sourceHash} data={result.data} />}
        </>
      )}
    </section>
  );
}
function AnglesResult({ data }: { data: PitchAnglesResponse }) {
  const [page, setPage] = useState(0),
    rows = data.games.flatMap((g) => g.groups.map((p) => ({ ...p, game: g }))),
    c = data.coverage;
  return (
    <>
      <p>
        전체 {c.actual}구 · 사용 {c.used}구 · 트래킹 없음 {c.missingTracking} · 미지원{" "}
        {c.unsupported} · 계산 불가 {c.invalid}. 기준면 {data.planeYFeet.toFixed(4)}ft.
      </p>
      <div className="table-scroll">
        <table aria-label="구종 진입각">
          <thead>
            <tr>
              {[
                "구종",
                "표본",
                "평균 VAA °",
                "VAA 표준편차 °",
                "평균 HAA °",
                "HAA 표준편차 °",
                "평균 높이 cm",
                "평균 가로 cm",
              ].map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <tr key={g.pitchType ?? "unknown"}>
                <th>{g.pitchType ?? "미상"}</th>
                <td>{g.pitches}</td>
                <td>{number(g.vaaDegrees)}</td>
                <td>{number(g.sdVaaDegrees)}</td>
                <td>{number(g.haaDegrees)}</td>
                <td>{number(g.sdHaaDegrees)}</td>
                <td>{number(g.meanHeightCm)}</td>
                <td>{number(g.meanSideCm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>등판별 진입각 변화</h3>
      <p>
        구장과 구종별 관측 평균입니다. 같은 날의 등판 순서는 추정하지 않으며 경기 근거로 구분합니다.
      </p>
      <div className="table-scroll">
        <table aria-label="등판별 진입각">
          <thead>
            <tr>
              {["경기", "구장", "구종", "표본", "VAA °", "HAA °", "높이 cm", "가로 cm"].map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 25, page * 25 + 25).map((g) => (
              <tr key={JSON.stringify([g.game.gameId, g.game.revision, g.pitchType])}>
                <td>
                  <Link
                    to={`/replay?${new URLSearchParams({ gameId: g.game.gameId, revision: String(g.game.revision) })}`}
                  >
                    {g.game.gameDate} r{g.game.revision}
                  </Link>
                </td>
                <td>{g.game.stadium ?? "미상"}</td>
                <td>{g.pitchType ?? "미상"}</td>
                <td>{g.pitches}</td>
                <td>{number(g.vaaDegrees)}</td>
                <td>{number(g.haaDegrees)}</td>
                <td>{number(g.meanHeightCm)}</td>
                <td>{number(g.meanSideCm)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>
        이전 등판
      </button>
      <button disabled={(page + 1) * 25 >= rows.length} onClick={() => setPage(page + 1)}>
        다음 등판
      </button>
    </>
  );
}
