import { useEffect, useState } from "react";
import { createRequestKey } from "../api/request-key";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { createImportForDocument, getImportJob } from "../api/import-client";
import { queryKeys } from "../api/query-options";
import type { CorrectionCommitCompletion } from "./use-correction-session-controller";

export function CommitCompletionPanel({
  completion,
  nextLabel,
  onNext,
}: {
  readonly completion: CorrectionCommitCompletion;
  readonly nextLabel: string | null;
  readonly onNext: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(createRequestKey);
  const create = useMutation({
    mutationFn: () =>
      createImportForDocument({
        gameId: completion.gameId,
        expectedDocumentHash: completion.documentHash,
        idempotencyKey,
      }),
  });
  const jobId = create.data?.jobId;
  const job = useQuery({
    queryKey: [...queryKeys.jobs.import, "completion", jobId],
    enabled: jobId !== undefined,
    queryFn: ({ signal }) => getImportJob(jobId ?? "", signal),
    refetchInterval: (query) =>
      query.state.data === undefined ||
      ["queued", "running"].includes(query.state.data.status) ||
      (query.state.data.followUpPending === true && query.state.data.error === null)
        ? 1_000
        : false,
  });
  useEffect(() => {
    if (job.data?.status !== "succeeded" || job.data.followUpPending === true) return;
    void Promise.all(
      [
        queryKeys.catalog,
        queryKeys.correction.games,
        queryKeys.databaseOverview,
        queryKeys.dashboard,
        queryKeys.recordCorrections.all,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }, [job.data?.status, job.data?.followUpPending, queryClient]);
  const ready = completion.outcome !== "quarantine_saved";
  const stored = job.data?.status === "succeeded";
  return (
    <div className="correction-completion-content">
      <strong>
        {completion.label} · {stored ? "DB 저장 완료" : "보정 저장 완료"}
      </strong>
      <p>
        {stored
          ? job.data?.followUpPending === true
            ? "DB 저장을 마쳤습니다. 작업 파일 정리 상태를 확인하고 있습니다."
            : "검증된 경기 기록을 DB에 저장했습니다."
          : ready
            ? "적재 가능한 원장으로 저장했습니다. 이 경기만 바로 DB에 적재할 수 있습니다."
            : "검토가 필요한 항목과 함께 작업 내용을 저장했습니다."}
      </p>
      <div className="operation-detail-actions">
        {ready && !stored ? (
          <button
            type="button"
            className="primary-button"
            disabled={create.isPending || jobId !== undefined}
            onClick={() => create.mutate()}
          >
            {create.isPending || job.data?.status === "queued" || job.data?.status === "running"
              ? "DB 적재 중…"
              : "이 경기 DB 적재"}
          </button>
        ) : null}
        {stored ? (
          <Link
            className="primary-button"
            to={`/replay?gameId=${encodeURIComponent(completion.gameId)}&revision=${job.data?.revision}`}
          >
            저장 경기 재생
          </Link>
        ) : null}
        {jobId === undefined ? null : (
          <Link
            className="secondary-button"
            to={`/database?scope=jobs&job=${encodeURIComponent(jobId)}`}
          >
            적재 결과 상세
          </Link>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={nextLabel === null}
          title={nextLabel ?? "남은 검토 경기가 없습니다."}
          onClick={onNext}
        >
          다음 검토 경기
        </button>
      </div>
      {nextLabel === null ? (
        <small>남은 검토 경기가 없습니다.</small>
      ) : (
        <small>다음: {nextLabel}</small>
      )}
      {create.error === null && job.error === null && job.data?.error == null ? null : (
        <p className="inline-error" role="alert">
          {create.error?.message ?? job.error?.message ?? job.data?.error}
        </p>
      )}
      <details>
        <summary>저장 정보</summary>
        <code>{completion.gameId}</code>
        <p>문서 hash: {completion.documentHash}</p>
      </details>
    </div>
  );
}
