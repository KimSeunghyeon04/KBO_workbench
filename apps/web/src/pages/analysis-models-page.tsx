import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AnalysisModelKind } from "@kbo/contracts";
import {
  getAnalysisModels,
  refreshAnalysisModels,
  cancelModelRefresh,
  setModelPolicy,
} from "../api/analysis-model-client";
import "../styles/analysis-models.css";
const names: Record<AnalysisModelKind, string> = {
  re24: "기대 득점 RE24",
  count: "카운트 기대 득점",
  win: "승리·무승부 확률",
  park: "구장 득점 환경",
  quality: "구질 기대 효과",
  matchup: "투타 매치업",
};
const states = {
  pending: "대기",
  running: "실행 중",
  skipped: "최신 모델 유지",
  published: "갱신 완료",
  succeeded: "완료",
  failed: "실패",
  cancelled: "중단",
  unsupported: "검증 이력 부족 · 제외",
};
const phases = {
  waiting: "대기",
  reading: "자료 읽기",
  fitting: "학습·검증",
  checking: "원천 재확인",
  publishing: "모델 저장",
  done: "완료",
};
export function AnalysisModelsPage() {
  const [season, setSeason] = useState(2025);
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["analysis-models", season],
    queryFn: ({ signal }) => getAnalysisModels(season, signal),
    refetchInterval: (result) => (result.state.data?.latestJob?.state === "running" ? 3000 : false),
  });
  const changed = async () => {
    await client.invalidateQueries({ queryKey: ["analysis-models"] });
  };
  const refresh = useMutation({
    mutationFn: (request: { id: string; force: boolean; season: number }) =>
      refreshAnalysisModels(request.id, request.force, request.season),
    onSuccess: changed,
  });
  const cancel = useMutation({ mutationFn: cancelModelRefresh, onSuccess: changed });
  const policy = useMutation({
    mutationFn: (request: { enabled: boolean; season: number }) =>
      setModelPolicy(request.enabled, request.season),
    onSuccess: changed,
  });
  const data = query.data,
    job = data?.latestJob,
    running = job?.state === "running",
    trainable = data?.models.some((model) => model.support === "eligible") ?? false;
  const error = query.error ?? refresh.error ?? cancel.error ?? policy.error;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>분석 모델 관리</h1>
          <p>
            적용 시즌 이전 자료로 학습·검증합니다. 적용 시즌의 결과는 모델 선택이 끝난 뒤 평가에만
            사용합니다.
          </p>
        </div>
      </header>
      <label>
        적용 시즌{" "}
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
          {[2025, 2024, 2023, 2022, 2021, 2020].map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{String(error)}</p>}
      <section className="panel">
        <h2>갱신 설정</h2>
        <p>
          선택한 시즌의 자동 갱신을 켜면 6시간마다 원천 변경을 확인합니다. 모든 시즌의 학습은 한
          번에 하나씩 실행하며 수분과 수 GB 메모리가 필요할 수 있습니다.
        </p>
        <label>
          <input
            type="checkbox"
            checked={data?.policy.enabledSeasons.includes(season) ?? false}
            disabled={!data || !trainable || policy.isPending}
            onChange={(e) => policy.mutate({ enabled: e.target.checked, season })}
          />{" "}
          {season} 시즌 자료 자동 갱신
        </label>
        <div className="model-refresh-actions">
          <button
            className="primary-button"
            disabled={!trainable || running || refresh.isPending}
            onClick={() => refresh.mutate({ id: crypto.randomUUID(), force: false, season })}
          >
            필요한 모델 갱신
          </button>
          <button
            className="secondary-button"
            disabled={!trainable || running || refresh.isPending}
            onClick={() => refresh.mutate({ id: crypto.randomUUID(), force: true, season })}
          >
            전체 다시 학습
          </button>
          <button
            className="secondary-button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            상태 새로고침
          </button>
        </div>
        {data && !trainable && (
          <p>
            수집 자료는 2020년부터입니다. 선행 학습 자료와 두 검증 시즌이 부족해 이 시즌은 관측
            통계만 제공합니다.
          </p>
        )}
        {data && <p>자동 갱신 시즌: {data.policy.enabledSeasons.join(", ") || "꺼짐"}</p>}
      </section>
      {data && (
        <section className="panel">
          <h2>모델 상태</h2>
          <div className="table-scroll">
            <table className="model-status-table" aria-label="모델 상태">
              <thead>
                <tr>
                  <th>모델</th>
                  <th>원천 상태</th>
                  <th>검증 채택</th>
                  <th>적용 시즌</th>
                  <th>학습 · 검증 기간</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((model) => (
                  <tr key={model.kind}>
                    <td>{names[model.kind]}</td>
                    <td>
                      {model.state === "current"
                        ? "최신"
                        : model.state === "stale"
                          ? "자료 변경 · 갱신 필요"
                          : model.state === "unsupported"
                            ? model.support === "unsupported_rules"
                              ? "시즌 규정 미지원"
                              : "선행 학습·검증 이력 부족"
                            : "모델 없음 또는 손상"}
                    </td>
                    <td>
                      {model.adoptedTargets} / {model.totalTargets}
                    </td>
                    <td>{model.applicationSeason}</td>
                    <td>
                      {model.trainedThrough < model.trainingStartSeason
                        ? "학습 자료 없음"
                        : `${model.trainingStartSeason}–${model.trainedThrough} 학습`}
                      <br />
                      검증: {model.validationSeasons.join(", ") || "없음"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            최신 여부와 검증 채택은 별개입니다. 검증을 통과하지 않은 항목은 기존 기준값 또는 제공
            불가 상태를 유지합니다.
          </p>
        </section>
      )}
      {job && (
        <section className="panel">
          <h2>
            최근 갱신 · {job.applicationSeason} 시즌 · {states[job.state]}
          </h2>
          <p>
            {new Date(job.createdAt).toLocaleString("ko-KR")} ·{" "}
            {job.trigger === "automatic" ? "자동" : "직접 실행"}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          {running && (
            <button
              className="secondary-button"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(job.id)}
            >
              갱신 중단
            </button>
          )}
          <ol>
            {job.steps.map((step) => (
              <li key={step.kind}>
                {names[step.kind]} · {states[step.state]}
                {step.state === "running" ? ` · ${phases[step.phase]}` : ""}
              </li>
            ))}
          </ol>
          <p>중단 전에 저장된 모델은 유지됩니다.</p>
        </section>
      )}
    </div>
  );
}
