import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReplayManifest } from "@kbo/contracts";
import { getWinProbabilities } from "../api/run-value-client";
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`),
  n = (v: number | null) => v?.toFixed(3) ?? "—";
export function WinProbabilityPanel({
  manifest,
  onSelect,
}: {
  manifest: ReplayManifest;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    query = useQuery({
      queryKey: ["win-probability", manifest.gameId, manifest.revision, manifest.documentHash],
      enabled: open,
      queryFn: ({ signal }) => getWinProbabilities(manifest, signal),
    }),
    data = query.data;
  return (
    <section className="panel">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        승리확률 {open ? "닫기" : "보기"}
      </button>
      {open && (
        <>
          <h2>홈 승리확률과 무승부 0.5 기준 WPA</h2>
          <p>
            곡선은 홈 승리확률 P(win)입니다. 가치는 P(win) + 0.5 × P(draw)이며, 같은 플레이의 원정
            WPA는 홈 WPA와 부호가 반대입니다. 개인 공로로 중복 배분하지 않습니다.
          </p>
          {query.isFetching && <p role="status">모델과 경기 운영 조건을 확인합니다.</p>}
          {query.error && <p role="alert">{query.error.message}</p>}
          {data && (
            <>
              {data.status !== "ready" ? (
                <p>
                  {data.status === "unsupported_rules"
                    ? "이 경기의 연장전 규정을 지원하는 모델이 없습니다. 2020·2021년 특례는 현재 미지원입니다."
                    : data.status === "incomplete_game"
                      ? "정상 종료 여부를 확인할 수 없어 확률을 표시하지 않습니다."
                      : "이전 시즌까지 학습한 유효 모델이 없습니다."}
                </p>
              ) : (
                <p>
                  {data.model?.trainedThrough}시즌까지 {data.model?.trainingGames}경기 · 경기 내
                  고유 상태 {data.model?.trainingStates}개 ·{" "}
                  {data.model?.method === "state_table" ? "축소 상태표" : "정규화 다항 로지스틱"}.
                  각 경기의 학습·평가 가중치 합계는 1입니다.
                  {data.model?.limits.includes(11) &&
                    " 과거 경기를 11회 종료 기준으로 재구성해 학습했습니다. 12회로 이어진 경기는 11회말 동점에서 무승부로 처리하며, 당시의 선수 운용 차이는 남을 수 있습니다."}
                </p>
              )}
              {data.status === "ready" && (
                <svg
                  viewBox="0 0 700 180"
                  role="img"
                  aria-label="홈 승리확률 곡선"
                  style={{ width: "100%", maxHeight: 240 }}
                >
                  <path d="M 30 10 V 160 H 690" fill="none" stroke="currentColor" />
                  <text x="1" y="15" fontSize="11">
                    100%
                  </text>
                  <text x="6" y="160" fontSize="11">
                    0%
                  </text>
                  {data.plays.map((p, i) =>
                    p.after === null ? null : (
                      <circle
                        key={p.playId}
                        cx={30 + (i / Math.max(1, data.plays.length - 1)) * 660}
                        cy={160 - p.after.homeWin * 150}
                        r="2"
                        fill="currentColor"
                      >
                        <title>
                          {p.playId}: {pct(p.after.homeWin)}
                        </title>
                      </circle>
                    ),
                  )}
                </svg>
              )}
              <p>
                시작 가치 {n(data.startValue)} · 종료 가치 {n(data.terminalValue)} · WPA 합계{" "}
                {n(data.wpaSum)} · 보존{" "}
                {data.conserved === null ? "미지원" : data.conserved ? "일치" : "불일치"}
              </p>
              {data.model && (
                <details>
                  <summary>시간 검증</summary>
                  <div className="table-scroll" tabIndex={0}>
                    <table aria-label="승리확률 검증">
                      <thead>
                        <tr>
                          {["모형", "λ", "시즌", "경기", "미지원 상태", "Log loss", "Brier"].map(
                            (s) => (
                              <th key={s}>{s}</th>
                            ),
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {data.model.validation.flatMap((v) =>
                          v.evaluations.map((e) => (
                            <tr key={`${v.method}-${v.lambda}-${e.season}`}>
                              <td>{v.method}</td>
                              <td>{v.lambda}</td>
                              <td>{e.season}</td>
                              <td>{e.games}</td>
                              <td>{e.unsupported}</td>
                              <td>{n(e.logLoss)}</td>
                              <td>{n(e.brier)}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="승리확률 플레이">
                  <thead>
                    <tr>
                      {["플레이", "홈 승", "무승부", "홈 패", "가치 W", "홈 WPA", "원정 WPA"].map(
                        (s) => (
                          <th key={s}>{s}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.plays.slice(page * 40, page * 40 + 40).map((p) => (
                      <tr key={p.playId}>
                        <th>
                          <button onClick={() => onSelect(p.playId)}>{p.playId}</button>
                          {p.terminal ? " · 종료" : ""}
                        </th>
                        <td>{pct(p.after?.homeWin)}</td>
                        <td>{pct(p.after?.draw)}</td>
                        <td>{pct(p.after?.homeLoss)}</td>
                        <td>{n(p.after?.value ?? null)}</td>
                        <td>{n(p.homeWpa)}</td>
                        <td>{n(p.awayWpa)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                이전 확률
              </button>
              <button
                disabled={(page + 1) * 40 >= data.plays.length}
                onClick={() => setPage(page + 1)}
              >
                다음 확률
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
