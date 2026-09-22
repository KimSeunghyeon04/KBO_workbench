import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AnalysisScopeQuery, PitchQualityResponse } from "@kbo/contracts";
import { getPitchQuality } from "../api/pitch-quality-client";
const percentage = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const labels = {
  swing: "스윙 / 적격 투구",
  whiff: "헛스윙 / 스윙",
  calledStrike: "루킹 / 비스윙",
  whiffPerPitch: "헛스윙 / 적격 투구",
} as const;
export function PitchQualityPanel({
  pitcherId,
  query,
}: {
  pitcherId: string;
  query: AnalysisScopeQuery;
}) {
  const [open, setOpen] = useState(false),
    analysis = useQuery({
      queryKey: ["pitch-quality", pitcherId, query],
      queryFn: ({ signal }) => getPitchQuality(pitcherId, query, signal),
      enabled: open,
    }),
    data = analysis.data;
  return (
    <section className="panel" aria-label="구종 기대 효과">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        구종 기대 효과 {open ? "접기" : "보기"}
      </button>
      {open && (
        <>
          <p>
            훈련 시즌까지 고정한 기준과 보정을 적용합니다. 헛스윙·루킹의 조건부 분모를 구분하며
            관측값과 기대값의 차이는 인과 효과가 아닙니다.
          </p>
          {analysis.isPending && <p role="status">모델과 표본 확인 중…</p>}
          {analysis.error && <p role="alert">{analysis.error.message}</p>}
          {data && <QualityResult data={data} />}
        </>
      )}
    </section>
  );
}
function QualityResult({ data }: { data: PitchQualityResponse }) {
  return (
    <>
      {data.status === "scope_mismatch" && <p>기대 확률은 확인된 정규시즌에서만 제공합니다.</p>}
      {data.status === "model_unavailable" && (
        <p>현재 원천에 맞는 학습 모델이 없습니다. 관측 비율만 표시합니다.</p>
      )}
      {data.status === "not_adopted" && (
        <p>새 모형이 채택 기준을 통과하지 않아 기대 확률을 표시하지 않습니다.</p>
      )}
      <p>
        전체 {data.coverage.actual}구 · 적격 제외 {data.coverage.ineligible} · 좌표/조건 누락{" "}
        {data.coverage.missing} · 보정 미지원 {data.coverage.calibrationUnsupported} · 학습 범위 밖{" "}
        {data.coverage.outOfSupport} · 모델 미준비 {data.coverage.modelUnavailable} · 비교 사용{" "}
        {data.coverage.used}구
      </p>
      {data.trainedThrough !== null && (
        <p>
          학습 종료 {data.trainedThrough}년 · 기대값은 채택된 대상에만 표시하며 관측값도 동일한 적용
          표본을 사용합니다.
        </p>
      )}
      <div className="table-scroll">
        <table aria-label="구종 관측 기대 비교">
          <thead>
            <tr>
              <th>구종</th>
              <th>대상 / 분모</th>
              <th>표본</th>
              <th>관측</th>
              <th>기대</th>
              <th>차이(%p)</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.flatMap((g) =>
              (Object.keys(labels) as (keyof typeof labels)[]).map((key) => {
                const r = g[key];
                return (
                  <tr key={`${g.pitchType ?? "unknown"}-${key}`}>
                    <th>{g.pitchType ?? "구종 미상"}</th>
                    <td>{labels[key]}</td>
                    <td>{r.samples}</td>
                    <td>{percentage(r.observed)}</td>
                    <td>{percentage(r.expected)}</td>
                    <td>{r.difference === null ? "—" : (100 * r.difference).toFixed(1)}</td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
      {data.models.length > 0 && (
        <details>
          <summary>고정 모델 평가</summary>
          <p>
            2023·2024 시간 검증으로 선택한 모형의 다음 시즌 평가입니다. 기존 구장 연구에서 같은
            기간을 확인했으므로 외부 검증으로 해석하지 않습니다.
          </p>
          <ul>
            {data.models.map((m) => (
              <li key={m.target}>
                {m.target}: {m.adopted ? m.kind : "미채택"} · {m.evaluation?.season}년 n=
                {m.evaluation?.samples ?? 0} · log loss {m.evaluation?.logLoss?.toFixed(4) ?? "—"} ·
                Brier {m.evaluation?.brier?.toFixed(4) ?? "—"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
