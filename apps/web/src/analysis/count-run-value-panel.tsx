import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ReplayManifest } from "@kbo/contracts";
import { getCountRunValues } from "../api/run-value-client";
const n = (v: number | null) => v?.toFixed(3) ?? "—";
export function CountRunValuePanel({
  manifest,
  onSelect,
}: {
  manifest: ReplayManifest;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(0),
    query = useQuery({
      queryKey: ["count-run-values", manifest.gameId, manifest.revision, manifest.documentHash],
      enabled: open,
      queryFn: ({ signal }) => getCountRunValues(manifest, signal),
    }),
    data = query.data;
  return (
    <section className="panel">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        투구·비투구 득점가치 {open ? "닫기" : "보기"}
      </button>
      {open && (
        <>
          <h2>카운트 기대득점</h2>
          <p>
            종결 투구와 연결된 타석 결과를 한 전이로 계산합니다. 도루·자동 판정·무투구 결과는 비투구
            값이며, 두 합계를 더해야 전체 가치가 됩니다. 공격팀 관점이며 개인 공로의 배분은
            아닙니다.
          </p>
          {query.isFetching && <p role="status">카운트 모델과 경기 상태를 읽습니다.</p>}
          {query.error && <p role="alert">{query.error.message}</p>}
          {data && (
            <>
              {data.status !== "ready" ? (
                <p>
                  현재 경기의 이전 시즌까지 학습한 유효 모델이 없습니다. 값은 미지원으로 표시합니다.
                </p>
              ) : (
                <p>
                  {data.model?.trainedThrough}시즌까지 {data.model?.trainingGames}경기 · 결정 시점{" "}
                  {data.model?.trainingSamples}건. 희소 상태는 RE24로 {data.model?.shrinkage}
                  표본만큼 축소합니다. 1–8회 완결 반이닝으로 학습하며 9회 이후는 참고값입니다.
                </p>
              )}
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="투구 비투구 가치 합계">
                  <thead>
                    <tr>
                      {["반이닝", "실제 득점", "시작 RE", "투구", "비투구", "전체", "보존"].map(
                        (s) => (
                          <th key={s}>{s}</th>
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
                        <td>{h.runs}</td>
                        <td>{n(h.startRE)}</td>
                        <td>{n(h.pitchValue)}</td>
                        <td>{n(h.nonPitchValue)}</td>
                        <td>{n(h.valueSum)}</td>
                        <td>{h.conserved === null ? "미지원" : h.conserved ? "일치" : "불일치"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="카운트 가치 전이">
                  <thead>
                    <tr>
                      {["근거 플레이", "구분", "득점", "이전 RE", "이후 RE", "가치", "상태"].map(
                        (s) => (
                          <th key={s}>{s}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.transitions.slice(page * 40, page * 40 + 40).map((t) => (
                      <tr key={t.playIds[0]}>
                        <th>
                          {t.playIds.map((id) => (
                            <button key={id} onClick={() => onSelect(id)}>
                              {id}
                            </button>
                          ))}
                        </th>
                        <td>
                          {t.kind === "pitch" ? "투구" : "비투구"}
                          {t.terminalLinked ? " · 종결 연결" : ""}
                        </td>
                        <td>{t.runs}</td>
                        <td>{n(t.beforeRE)}</td>
                        <td>{n(t.afterRE)}</td>
                        <td>{n(t.value)}</td>
                        <td>
                          {t.status === "supported"
                            ? "지원"
                            : t.status === "incomplete_half"
                              ? "미완결"
                              : t.status === "unsupported_link"
                                ? "종결 연결 미지원"
                                : t.status === "unsupported_state"
                                  ? "상태 미지원"
                                  : t.status === "boundary"
                                    ? "경계"
                                    : "미적용"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                이전 전이
              </button>
              <button
                disabled={(page + 1) * 40 >= data.transitions.length}
                onClick={() => setPage(page + 1)}
              >
                다음 전이
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
