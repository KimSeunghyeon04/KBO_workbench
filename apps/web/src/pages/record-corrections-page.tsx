import { useCallback, useDeferredValue, useEffect, useRef, useState, useTransition } from "react";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import type {
  RecordCorrectionCase,
  RecordCorrectionCaseStatus,
  RecordCorrectionListItem,
  RecordCorrectionQueue,
  RecordCorrectionSummary,
} from "@kbo/contracts";

import {
  createRecordCorrectionDraft,
  createRecordCorrectionJob,
  submitRecordCorrectionReviewAction,
} from "../api/client";
import {
  queryKeys,
  recordCorrectionCaseQueryOptions,
  recordCorrectionCasesQueryOptions,
  recordCorrectionJobsQueryOptions,
  recordCorrectionSummaryQueryOptions,
} from "../api/query-options";
import { OperationConsole, OperationEmptyDetail } from "../components/operation-console";
import { SelectableVirtualList } from "../components/selectable-virtual-list";

const statusOptions: readonly [RecordCorrectionCaseStatus, string][] = [
  ["action_required", "적용 가능"],
  ["manual_review", "후보 확인"],
  ["unmatched", "DB 경기 없음"],
  ["already_applied", "이미 반영"],
  ["out_of_scope", "지원 범위 외"],
  ["resolved", "해결됨"],
  ["dismissed", "무시됨"],
];
const statuses = new Set(statusOptions.map(([status]) => status));
const queues = new Set<RecordCorrectionQueue>(["needs_action", "completed", "all"]);

export function RecordCorrectionsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [, startTransition] = useTransition();
  const [dismissReason, setDismissReason] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const selectedNoticeId = searchParams.get("notice");
  const queueValue = searchParams.get("queue");
  const queue =
    queueValue !== null && queues.has(queueValue as RecordCorrectionQueue)
      ? (queueValue as RecordCorrectionQueue)
      : "needs_action";
  const statusValue = searchParams.get("status");
  const status =
    statusValue !== null && statuses.has(statusValue as RecordCorrectionCaseStatus)
      ? (statusValue as RecordCorrectionCaseStatus)
      : null;
  const seasonText = searchParams.get("season") ?? "";
  const search = searchParams.get("q") ?? "";
  const deferredSearch = useDeferredValue(search.trim());
  const filters = {
    ...(seasonText === "" ? {} : { season: Number(seasonText) }),
    ...(status === null ? {} : { status }),
    queue,
    ...(deferredSearch === "" ? {} : { search: deferredSearch }),
  };
  const summary = useQuery(recordCorrectionSummaryQueryOptions());
  const jobs = useQuery({
    ...recordCorrectionJobsQueryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => ["queued", "running", "cancelling"].includes(job.status)) ===
      true
        ? 2_000
        : false,
  });
  const cases = useQuery(recordCorrectionCasesQueryOptions(filters));
  const selected = useQuery({
    ...recordCorrectionCaseQueryOptions(selectedNoticeId ?? "inactive"),
    enabled: selectedNoticeId !== null,
  });

  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | null>>, replace = false): void => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      startTransition(() => setSearchParams(next, { replace }));
    },
    [searchParams, setSearchParams],
  );
  useEffect(() => setDismissReason(""), [selectedNoticeId]);

  const invalidate = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.recordCorrections.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.recordCorrection }),
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
    ]);
  }, [queryClient]);
  const hadActiveJob = useRef(false);
  useEffect(() => {
    const active =
      jobs.data?.some((job) => ["queued", "running", "cancelling"].includes(job.status)) === true;
    if (hadActiveJob.current && !active) void invalidate();
    hadActiveJob.current = active;
  }, [invalidate, jobs.data]);

  const sync = useMutation({
    mutationFn: () => createRecordCorrectionJob(),
    onSuccess: invalidate,
  });
  const review = useMutation({
    mutationFn: (input: {
      readonly item: RecordCorrectionCase;
      readonly action: "select_candidate" | "dismiss" | "reopen";
      readonly candidateId: string | null;
      readonly reason: string | null;
    }) =>
      submitRecordCorrectionReviewAction(input.item.noticeId, {
        caseVersion: input.item.caseVersion,
        action: input.action,
        candidateId: input.candidateId,
        reason: input.reason,
      }),
    onSuccess: async (updated) => {
      let remaining: number | null = null;
      if (!belongsToQueue(updated.status, queue)) {
        const items = cases.data ?? [];
        const index = items.findIndex((item) => item.noticeId === updated.noticeId);
        const next = items[index + 1] ?? items[index - 1] ?? null;
        remaining = items.filter((item) => item.noticeId !== updated.noticeId).length;
        updateSearch({ notice: next?.noticeId ?? null }, true);
      }
      setFeedback(reviewFeedback(updated.status, remaining));
      await invalidate();
    },
  });
  const draft = useMutation({
    mutationFn: (noticeId: string) => createRecordCorrectionDraft(noticeId),
    onSuccess: (created) => {
      void navigate(
        `/correct?sessionId=${encodeURIComponent(created.sessionId)}&noticeId=${encodeURIComponent(created.noticeId)}`,
      );
    },
  });
  const error =
    summary.error ??
    jobs.error ??
    cases.error ??
    selected.error ??
    sync.error ??
    review.error ??
    draft.error;
  const activeJob = jobs.data?.find((job) =>
    ["queued", "running", "cancelling"].includes(job.status),
  );
  const actionableCount =
    (summary.data?.counts.actionRequired ?? 0) +
    (summary.data?.counts.manualReview ?? 0) +
    (summary.data?.counts.unmatched ?? 0);
  const completedCount = summaryTotal(summary.data) - actionableCount;

  return (
    <div className="page-stack operation-page record-correction-page">
      <header className="page-header operation-page-header">
        <div>
          <h1>KBO 기록정정</h1>
          <p>처리가 필요한 공식 정정부터 순서대로 검토합니다.</p>
        </div>
        <div className="operation-status-line">
          <span>
            미처리 <strong>{String(actionableCount)}</strong>
          </span>
          <span>
            최근 동기화 <strong>{formatDateTime(summary.data?.lastSuccessfulAt ?? null)}</strong>
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={sync.isPending || activeJob !== undefined}
            onClick={() => sync.mutate()}
          >
            {activeJob === undefined ? "지금 동기화" : jobStatusLabel(activeJob.status)}
          </button>
        </div>
      </header>

      {error !== null ? <div className="error-panel">{error.message}</div> : null}
      {feedback !== null ? (
        <div className="success-panel" role="status">
          {feedback}
        </div>
      ) : null}

      <OperationConsole
        selected={selectedNoticeId !== null}
        onBack={() => updateSearch({ notice: null })}
        master={
          <>
            <div className="operation-list-toolbar record-correction-list-toolbar">
              <div className="operation-segments" aria-label="기록정정 큐">
                {(
                  [
                    ["needs_action", "미처리", actionableCount],
                    ["completed", "완료·제외", completedCount],
                    ["all", "전체", summaryTotal(summary.data)],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    type="button"
                    className={queue === value ? "selected" : undefined}
                    key={value}
                    onClick={() =>
                      updateSearch({
                        queue: value === "needs_action" ? null : value,
                        status: null,
                        notice: null,
                      })
                    }
                  >
                    {label} {String(count)}
                  </button>
                ))}
              </div>
              <label className="operation-search">
                <span>팀·선수 검색</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => updateSearch({ q: event.target.value }, true)}
                />
              </label>
              <label>
                <span>시즌</span>
                <input
                  className="compact-number-input"
                  inputMode="numeric"
                  value={seasonText}
                  placeholder="전체"
                  onChange={(event) =>
                    updateSearch(
                      { season: event.target.value.replace(/\D/g, "").slice(0, 4) },
                      true,
                    )
                  }
                />
              </label>
              <label>
                <span>상태</span>
                <select
                  value={status ?? "all"}
                  onChange={(event) =>
                    updateSearch({
                      status: event.target.value === "all" ? null : event.target.value,
                      notice: null,
                    })
                  }
                >
                  <option value="all">전체</option>
                  {statusOptions.map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <SelectableVirtualList
              ariaLabel="기록정정 공지 목록"
              emptyMessage={
                cases.isLoading ? "공지를 불러오는 중입니다." : "이 큐에 남은 공지가 없습니다."
              }
              getKey={(item) => item.noticeId}
              items={cases.data ?? []}
              rowHeight={84}
              selectedKey={selectedNoticeId}
              onSelect={(item) => {
                setFeedback(null);
                updateSearch({ notice: item.noticeId });
              }}
              renderItem={(item) => <RecordCorrectionRow item={item} />}
            />
          </>
        }
        detail={
          selectedNoticeId === null ? (
            <OperationEmptyDetail
              title="검토할 공지를 선택하세요"
              description="목록에는 판단에 필요한 최소 정보만 표시하고, 원문과 후보는 선택 후 불러옵니다."
            />
          ) : selected.isLoading || selected.data === undefined ? (
            <OperationEmptyDetail
              title="공지 상세를 불러오는 중입니다"
              description="선택한 공지만 조회하고 있습니다."
            />
          ) : (
            <RecordCorrectionDetail
              item={selected.data}
              dismissReason={dismissReason}
              pending={review.isPending || draft.isPending}
              onDismissReason={setDismissReason}
              onSelectCandidate={(candidateId) =>
                review.mutate({
                  item: selected.data,
                  action: "select_candidate",
                  candidateId,
                  reason: null,
                })
              }
              onDismiss={() =>
                review.mutate({
                  item: selected.data,
                  action: "dismiss",
                  candidateId: null,
                  reason: dismissReason.trim() || null,
                })
              }
              onReopen={() =>
                review.mutate({
                  item: selected.data,
                  action: "reopen",
                  candidateId: null,
                  reason: null,
                })
              }
              onDraft={() => draft.mutate(selected.data.noticeId)}
            />
          )
        }
      />
    </div>
  );
}

function RecordCorrectionRow({
  item,
}: {
  readonly item: RecordCorrectionListItem;
}): React.JSX.Element {
  return (
    <>
      <span className="operation-row-heading">
        <strong>
          {item.awayTeamName} vs {item.homeTeamName}
        </strong>
        <span className={`record-correction-status ${item.status}`}>
          {statusLabel(item.status)}
        </span>
      </span>
      <span className="operation-row-meta">
        <span>
          {item.gameDate} · {item.venueName}
        </span>
      </span>
      <span className="operation-row-copy">
        {item.beforeRecordText} → {item.afterRecordText}
      </span>
    </>
  );
}

function RecordCorrectionDetail(props: {
  readonly item: RecordCorrectionCase;
  readonly dismissReason: string;
  readonly pending: boolean;
  readonly onDismissReason: (value: string) => void;
  readonly onSelectCandidate: (candidateId: string) => void;
  readonly onDismiss: () => void;
  readonly onReopen: () => void;
  readonly onDraft: () => void;
}): React.JSX.Element {
  const { item } = props;
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>
            {item.notice.awayTeamName} vs {item.notice.homeTeamName}
          </h2>
          <p className="muted-text">
            KBO #{String(item.notice.recordNumber)} · {item.notice.seriesName}
          </p>
        </div>
        <span className={`record-correction-status ${item.status}`}>
          {statusLabel(item.status)}
        </span>
      </header>
      <dl className="operation-detail-fields">
        <div>
          <dt>경기</dt>
          <dd>
            {item.notice.gameDate} · {item.notice.venueName}
            {item.notice.doubleheaderNumber === null
              ? ""
              : ` · DH${String(item.notice.doubleheaderNumber)}`}
          </dd>
        </div>
        <div>
          <dt>플레이</dt>
          <dd>
            {item.notice.inning}회 {item.notice.half === "top" ? "초" : "말"} ·{" "}
            {item.notice.battingOrder}번 타자
          </dd>
        </div>
        <div>
          <dt>정정</dt>
          <dd>
            {item.notice.beforeRecordText} → {item.notice.afterRecordText}
          </dd>
        </div>
        <div>
          <dt>판정 근거</dt>
          <dd>{item.reasonMessage}</dd>
        </div>
      </dl>
      <h3>전후 공식 기록</h3>
      <div className="record-correction-stat-list">
        {item.notice.statChanges.map((stat) => {
          const participant =
            stat.participantIndex === null ? null : item.notice.participants[stat.participantIndex];
          return (
            <div key={stat.statIndex}>
              <strong>{participant?.rawPlayerName ?? "선수 미지정"}</strong>
              <span>
                {stat.rawStatName}: {String(stat.beforeValue)} → {String(stat.afterValue)}
              </span>
              <small>{supportLabel(stat.supportKind)}</small>
            </div>
          );
        })}
        {item.notice.statChanges.length === 0 ? (
          <p className="muted-text">구조화된 통계 변경이 없습니다.</p>
        ) : null}
      </div>
      {item.candidates.length > 1 ||
      (item.status === "manual_review" && item.candidates.length > 0) ? (
        <>
          <h3>서버 후보</h3>
          <div className="record-correction-candidates">
            {item.candidates.map((candidate) => (
              <button
                type="button"
                className="secondary-button"
                key={candidate.candidateId}
                disabled={props.pending}
                onClick={() => props.onSelectCandidate(candidate.candidateId)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="operation-detail-actions record-correction-actions">
        <a
          className="secondary-button"
          href="https://www.koreabaseball.com/Record/RecordCorrect/RecordCorrect.aspx"
          target="_blank"
          rel="noreferrer"
        >
          KBO 원문
        </a>
        {item.status === "dismissed" ? (
          <button
            type="button"
            className="secondary-button"
            disabled={props.pending}
            onClick={props.onReopen}
          >
            재검토
          </button>
        ) : item.status === "out_of_scope" ? null : (
          <>
            <input
              value={props.dismissReason}
              onChange={(event) => props.onDismissReason(event.target.value)}
              placeholder="무시 사유"
            />
            <button
              type="button"
              className="secondary-button"
              disabled={props.pending || props.dismissReason.trim() === ""}
              onClick={props.onDismiss}
            >
              무시
            </button>
          </>
        )}
        <button
          type="button"
          className="primary-button"
          disabled={
            props.pending ||
            item.gameId === null ||
            item.eventId === null ||
            item.status === "resolved" ||
            item.status === "out_of_scope"
          }
          onClick={props.onDraft}
        >
          보정 작업대로 이동
        </button>
      </div>
    </div>
  );
}

function belongsToQueue(status: RecordCorrectionCaseStatus, queue: RecordCorrectionQueue): boolean {
  if (queue === "all") return true;
  const actionable =
    status === "action_required" || status === "manual_review" || status === "unmatched";
  return queue === "needs_action" ? actionable : !actionable;
}

function reviewFeedback(status: RecordCorrectionCaseStatus, remaining: number | null): string {
  if (status !== "dismissed" && status !== "resolved") return "검토 결과를 저장했습니다.";
  const action =
    status === "dismissed" ? "공지를 무시 처리했습니다." : "기록정정 처리를 완료했습니다.";
  if (remaining === null) return action;
  return remaining === 0
    ? `${action} 미처리 큐가 비었습니다.`
    : `${action} 다음 항목을 선택했으며 ${String(remaining)}건 남았습니다.`;
}

function statusLabel(status: RecordCorrectionCaseStatus): string {
  return statusOptions.find(([value]) => value === status)?.[1] ?? status;
}

function summaryTotal(summary: RecordCorrectionSummary | undefined): number {
  if (summary === undefined) return 0;
  return Object.values(summary.counts).reduce((total, count) => total + count, 0);
}

function supportLabel(
  kind: RecordCorrectionCase["notice"]["statChanges"][number]["supportKind"],
): string {
  return {
    direct: "적용 지원",
    derived: "파생 검증",
    evidence_only: "현 범위 제외",
    unknown: "미분류·범위 제외",
  }[kind];
}

function formatDateTime(value: string | null): string {
  return value === null
    ? "없음"
    : new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      );
}

function jobStatusLabel(status: string): string {
  return (
    {
      queued: "동기화 대기",
      running: "동기화 중",
      cancelling: "취소 중",
      cancelled: "취소됨",
      succeeded: "성공",
      failed: "실패",
      no_change: "변경 없음",
    }[status] ?? status
  );
}
