import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReplayManifest } from "@kbo/contracts";
import { getRunValues } from "../api/run-value-client";
const n = (value: number | null) => value?.toFixed(3) ?? "—";
export function RunValuePanel({
  manifest,
  onSelect,
}: {
  manifest: ReplayManifest;
  onSelect: (playId: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    query = useQuery({
      queryKey: ["run-values", manifest.gameId, manifest.revision, manifest.documentHash],
      enabled: open,
      queryFn: ({ signal }) => getRunValues(manifest, signal),
    });
  const data = query.data;
  return (
    <section className="panel">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        플레이 득점가치 {open ? "닫기" : "보기"}
      </button>
      {open && (
        <>
          <h2>완결 반이닝의 RE24</h2>
          <p>
            공격팀 가치 = 실제 득점 + 이후 기대득점 − 이전 기대득점. 투수팀 관점은 부호가
            반대입니다. 한 플레이를 타자·주자·수비수의 개인 공로로 나눠 더하지 않습니다.
          </p>
          {query.isFetching && <p role="status">현재 모델과 경기 원천을 확인합니다.</p>}
          {query.error && <p role="alert">{query.error.message}</p>}
          {data && (
            <>
              {data.status !== "ready" ? (
                <p>
                  {data.status === "model_unavailable"
                    ? "학습 모델이 없거나 원천 변경으로 재학습이 필요합니다."
                    : "이 경기는 선택된 모델의 학습 기간에 포함되어 평가 값을 표시하지 않습니다."}
                </p>
              ) : (
                <p>
                  {data.modelTrainedThrough}시즌까지의 정규 9이닝 경기 · 1–8회 완결 반이닝 PA 시작
                  상태로 학습했습니다. 9회 이후는 참고값이며, 끝내기·중도 종료의 남은 기대득점을
                  0으로 처리하지 않습니다.
                </p>
              )}
              {data.model && (
                <details>
                  <summary>학습 표본과 검증</summary>
                  <p>
                    {data.model.trainingGames}경기 · 타석 시작 {data.model.trainingSamples}건 ·{" "}
                    {data.model.method}. 후보 비교는 2023·2024년 순차 검증과 경기 단위 1,200회
                    bootstrap을 사용합니다.
                  </p>
                  <div className="table-scroll" tabIndex={0}>
                    <table aria-label="RE24 학습 상태표">
                      <thead>
                        <tr>
                          <th>아웃</th>
                          <th>주자 상태 (1·2·3루 비트)</th>
                          <th>표본</th>
                          <th>RE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.model.cells.map((c) => (
                          <tr key={`${c.outs}-${c.bases}`}>
                            <td>{c.outs}</td>
                            <td>{c.bases.toString(2).padStart(3, "0")}</td>
                            <td>{c.samples}</td>
                            <td>{n(c.mean)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-scroll" tabIndex={0}>
                    <table aria-label="RE24 시간 검증">
                      <thead>
                        <tr>
                          <th>방법</th>
                          <th>평가 시즌</th>
                          <th>표본</th>
                          <th>미지원</th>
                          <th>MAE</th>
                          <th>RMSE</th>
                          <th>편향</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.model.validation.flatMap((v) =>
                          v.evaluations.map((e) => (
                            <tr key={`${v.method}-${e.season}`}>
                              <td>{v.method}</td>
                              <td>{e.season}</td>
                              <td>{e.samples}</td>
                              <td>{e.unsupported}</td>
                              <td>{n(e.mae)}</td>
                              <td>{n(e.rmse)}</td>
                              <td>{n(e.bias)}</td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="반이닝 득점가치">
                  <thead>
                    <tr>
                      {["반이닝", "완결", "실제 득점", "시작 RE", "가치 합계", "보존 확인"].map(
                        (v) => (
                          <th key={v}>{v}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.halves.map((h) => (
                      <tr key={`${h.inning}-${h.half}`}>
                        <th>
                          {h.inning}회 {h.half === "top" ? "초" : "말"}
                          {h.referenceOnly ? " · 참고" : ""}
                        </th>
                        <td>{h.complete ? "3아웃" : "미완결"}</td>
                        <td>{h.runs}</td>
                        <td>{n(h.startRE)}</td>
                        <td>{n(h.valueSum)}</td>
                        <td>{h.conserved === null ? "미지원" : h.conserved ? "일치" : "불일치"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="플레이 득점가치">
                  <thead>
                    <tr>
                      {["플레이", "종류", "득점", "이전 RE", "이후 RE", "공격팀 가치", "상태"].map(
                        (v) => (
                          <th key={v}>{v}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.plays.slice(page * 50, page * 50 + 50).map((p) => (
                      <tr key={p.playId}>
                        <th>
                          <button onClick={() => onSelect(p.playId)}>{p.playId}</button>
                        </th>
                        <td>
                          {p.action === "steal_only"
                            ? "단일 주자 도루/실패"
                            : p.action === "bunt"
                              ? "명시된 번트"
                              : p.action === "compound"
                                ? "복합 플레이"
                                : p.kind}
                        </td>
                        <td>{p.runs}</td>
                        <td>{n(p.beforeRE)}</td>
                        <td>{n(p.afterRE)}</td>
                        <td>{n(p.value)}</td>
                        <td>
                          {p.status === "supported"
                            ? "지원"
                            : p.status === "incomplete_half"
                              ? "미완결 반이닝"
                              : p.status === "unsupported_state"
                                ? "상태 표본 없음"
                                : p.status === "boundary"
                                  ? "경계"
                                  : "미적용"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                이전 가치
              </button>
              <button
                disabled={(page + 1) * 50 >= data.plays.length}
                onClick={() => setPage(page + 1)}
              >
                다음 가치
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
