import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RecordCorrectionCase,
  RecordCorrectionCaseStatus,
  RecordCorrectionSummary,
} from "@kbo/contracts";
import { useNavigate } from "react-router-dom";

import {
  createRecordCorrectionDraft,
  createRecordCorrectionJob,
  submitRecordCorrectionReviewAction,
} from "../api/client";
import {
  queryKeys,
  recordCorrectionCasesQueryOptions,
  recordCorrectionJobsQueryOptions,
  recordCorrectionSummaryQueryOptions,
} from "../api/query-options";

const STATUS_OPTIONS: readonly [RecordCorrectionCaseStatus, string][] = [
  ["action_required", "미반영"],
  ["already_applied", "이미 반영"],
  ["manual_review", "수동 검토"],
  ["out_of_scope", "지원 범위 외"],
  ["unmatched", "DB 경기 없음"],
  ["resolved", "해결됨"],
  ["dismissed", "무시됨"],
];

export function RecordCorrectionsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [seasonText, setSeasonText] = useState("");
  const [status, setStatus] = useState<RecordCorrectionCaseStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedNoticeId, setSelectedNoticeId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const filters = {
    ...(seasonText === "" ? {} : { season: Number(seasonText) }),
    ...(status === "all" ? {} : { status }),
    ...(search.trim() === "" ? {} : { search }),
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
  const selected = useMemo(
    () => cases.data?.find((item) => item.noticeId === selectedNoticeId) ?? cases.data?.[0] ?? null,
    [cases.data, selectedNoticeId],
  );
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
    onSuccess: invalidate,
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
    summary.error ?? jobs.error ?? cases.error ?? sync.error ?? review.error ?? draft.error;

  return (
    <div className="page-stack record-correction-page">
      <header className="page-header">
        <div>
          <h1>KBO 기록정정 검토함</h1>
          <p>공식 정정 공지를 원문 증거로 보존하고 현재 sealed 경기와 비교합니다.</p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={
            sync.isPending ||
            jobs.data?.some((job) => ["queued", "running", "cancelling"].includes(job.status))
          }
          onClick={() => sync.mutate()}
        >
          지금 동기화
        </button>
      </header>

      {error !== null ? <div className="error-panel">{error.message}</div> : null}

      <section className="record-correction-summary" aria-label="기록정정 상태 요약">
        {STATUS_OPTIONS.map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={status === value ? "metric-card selected" : "metric-card"}
            onClick={() => setStatus(value)}
          >
            <span>{label}</span>
            <strong>{String(statusCount(summary.data, value))}</strong>
          </button>
        ))}
      </section>

      <section className="panel record-correction-schedule">
        <span>마지막 성공: {formatDateTime(summary.data?.lastSuccessfulAt ?? null)}</span>
        <span>다음 예정: {formatDateTime(summary.data?.nextScheduledAt ?? null)}</span>
        <span>
          최근 job: {jobs.data?.[0] === undefined ? "없음" : jobStatusLabel(jobs.data[0].status)}
        </span>
      </section>

      <section className="panel record-correction-filters">
        <label>
          <span>시즌</span>
          <input
            inputMode="numeric"
            value={seasonText}
            placeholder="전체"
            onChange={(event) => setSeasonText(event.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </label>
        <label>
          <span>상태</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="all">전체</option>
            {STATUS_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="record-correction-search">
          <span>팀·선수</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setSeasonText("");
            setStatus("all");
            setSearch("");
          }}
        >
          필터 초기화
        </button>
      </section>

      <div className="record-correction-layout">
        <section className="panel record-correction-list" aria-label="기록정정 공지 목록">
          <div className="panel-title-row">
            <h2>공지</h2>
            <span>{String(cases.data?.length ?? 0)}건</span>
          </div>
          {(cases.data ?? []).map((item) => (
            <button
              type="button"
              key={item.noticeId}
              className={
                selected?.noticeId === item.noticeId
                  ? "record-correction-row selected"
                  : "record-correction-row"
              }
              onClick={() => setSelectedNoticeId(item.noticeId)}
            >
              <span className={`record-correction-status ${item.status}`}>
                {statusLabel(item.status)}
              </span>
              <strong>
                {item.notice.awayTeamName} vs {item.notice.homeTeamName}
              </strong>
              <span>
                {item.notice.gameDate} · {item.notice.venueName}
              </span>
              <small>
                {item.notice.beforeRecordText} → {item.notice.afterRecordText}
              </small>
            </button>
          ))}
          {cases.isLoading ? <p className="muted-text">공지를 불러오는 중입니다.</p> : null}
          {!cases.isLoading && cases.data?.length === 0 ? (
            <p className="muted-text">조건에 맞는 공지가 없습니다.</p>
          ) : null}
        </section>

        <section className="panel record-correction-detail">
          {selected === null ? (
            <p className="muted-text">검토할 공지를 선택하세요.</p>
          ) : (
            <RecordCorrectionDetail
              item={selected}
              dismissReason={dismissReason}
              pending={review.isPending || draft.isPending}
              onDismissReason={setDismissReason}
              onSelectCandidate={(candidateId) =>
                review.mutate({
                  item: selected,
                  action: "select_candidate",
                  candidateId,
                  reason: null,
                })
              }
              onDismiss={() =>
                review.mutate({
                  item: selected,
                  action: "dismiss",
                  candidateId: null,
                  reason: dismissReason.trim() || null,
                })
              }
              onReopen={() =>
                review.mutate({ item: selected, action: "reopen", candidateId: null, reason: null })
              }
              onDraft={() => draft.mutate(selected.noticeId)}
            />
          )}
        </section>
      </div>
    </div>
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
    <>
      <div className="section-heading">
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
      </div>
      <dl className="record-correction-fields">
        <div>
          <dt>경기</dt>
          <dd>
            {item.notice.gameDate} {item.notice.venueName}
            {item.notice.doubleheaderNumber === null
              ? ""
              : ` DH${String(item.notice.doubleheaderNumber)}`}
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
          <dt>판정</dt>
          <dd>
            {item.notice.beforeRecordText} → {item.notice.afterRecordText}
          </dd>
        </div>
        <div>
          <dt>정정일</dt>
          <dd>{item.notice.correctionDateText}</dd>
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
      <div className="record-correction-actions">
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
    </>
  );
}

function statusLabel(status: RecordCorrectionCaseStatus): string {
  return STATUS_OPTIONS.find(([value]) => value === status)?.[1] ?? status;
}

function statusCount(
  summary: RecordCorrectionSummary | undefined,
  status: RecordCorrectionCaseStatus,
): number {
  if (summary === undefined) return 0;
  return {
    action_required: summary.counts.actionRequired,
    already_applied: summary.counts.alreadyApplied,
    manual_review: summary.counts.manualReview,
    out_of_scope: summary.counts.outOfScope,
    unmatched: summary.counts.unmatched,
    resolved: summary.counts.resolved,
    dismissed: summary.counts.dismissed,
  }[status];
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
      queued: "대기",
      running: "실행 중",
      cancelling: "취소 중",
      cancelled: "취소됨",
      succeeded: "성공",
      failed: "실패",
      no_change: "변경 없음",
    }[status] ?? status
  );
}
