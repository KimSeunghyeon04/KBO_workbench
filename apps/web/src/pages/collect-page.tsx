import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  CollectionJob,
  CollectionJobCreateRequest,
  GameCatalogItem,
  JobEvent,
} from "@kbo/contracts";

import { cancelCollectionJob, createCollectionJob } from "../api/client";
import {
  catalogQueryOptions,
  collectionJobsQueryOptions,
  queryKeyForRefreshTarget,
  queryKeys,
} from "../api/query-options";
import {
  collectionRefreshTargets,
  decodeCollectionJobEvent,
} from "../collection/job-event-refresh";
import { useFixedVirtualList } from "../components/use-fixed-virtual-list";

const terminal = new Set<CollectionJob["status"]>(["cancelled", "succeeded", "failed"]);

export function CollectPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const today = useMemo(todayInLocalTimezone, []);
  const [mode, setMode] = useState<"date_range" | "season">("date_range");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [season, setSeason] = useState(today.slice(0, 4));
  const jobs = useQuery({
    ...collectionJobsQueryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminal.has(job.status)) === true ? 2_000 : false,
  });
  const catalog = useQuery(catalogQueryOptions());
  const activeJobs = jobs.data?.filter((job) => !terminal.has(job.status)) ?? [];

  const refreshCollection = useCallback(
    async (event: JobEvent) => {
      await Promise.all(
        collectionRefreshTargets(event).map((target) =>
          queryClient.invalidateQueries(
            { queryKey: queryKeyForRefreshTarget(target) },
            { cancelRefetch: false },
          ),
        ),
      );
    },
    [queryClient],
  );
  useJobEvents(activeJobs, refreshCollection);

  const createMutation = useMutation({
    mutationFn: createCollectionJob,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.jobs.collection }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
    },
  });
  const cancelMutation = useMutation({
    mutationFn: cancelCollectionJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.collection });
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const range =
      mode === "season"
        ? { startDate: `${season}-01-01`, endDate: `${season}-12-31` }
        : { startDate, endDate };
    const request: CollectionJobCreateRequest = {
      scope: { kind: "date_range", ...range },
      idempotencyKey: crypto.randomUUID(),
    };
    createMutation.mutate(request);
  };

  return (
    <div className="page-stack collect-page">
      <header className="page-header">
        <div>
          <h1>경기 수집</h1>
          <p>완료된 KBO 경기의 Naver 원천 자료를 strict 문서로 수집합니다.</p>
        </div>
        <span className="phase-label">동시 실행 1개</span>
      </header>

      <section className="panel">
        <div className="section-heading">
          <h2>수집 범위</h2>
          <span className="muted-text">경기 단위로 원자 저장</span>
        </div>
        <form className="collection-form" onSubmit={submit}>
          <label>
            <span>범위</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="date_range">날짜 범위</option>
              <option value="season">시즌 전체</option>
            </select>
          </label>
          {mode === "date_range" ? (
            <>
              <label>
                <span>시작일</span>
                <input
                  type="date"
                  value={startDate}
                  max={endDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  required
                />
              </label>
              <label>
                <span>종료일</span>
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label>
              <span>시즌</span>
              <input
                type="number"
                min="1982"
                max="9999"
                value={season}
                onChange={(event) => setSeason(event.target.value)}
                required
              />
            </label>
          )}
          <button className="primary-button" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "등록 중" : "수집 시작"}
          </button>
        </form>
        {createMutation.error !== null && (
          <div className="inline-error">{createMutation.error.message}</div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>수집 작업</h2>
          <span className="muted-text">{jobs.data?.length ?? 0}개</span>
        </div>
        {jobs.isLoading ? <p className="muted-text list-message">불러오는 중</p> : null}
        {jobs.error !== null ? <div className="inline-error">{jobs.error.message}</div> : null}
        <div className="job-list">
          {jobs.data?.map((job) => (
            <JobRow key={job.jobId} job={job} onCancel={() => cancelMutation.mutate(job.jobId)} />
          ))}
          {jobs.data?.length === 0 ? (
            <p className="muted-text list-message">아직 실행한 작업이 없습니다.</p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>수집 결과</h2>
          <span className="muted-text">{catalog.data?.games.length ?? 0}경기</span>
        </div>
        <CatalogResults games={catalog.data?.games ?? []} />
      </section>
    </div>
  );
}

function CatalogResults({ games }: { readonly games: readonly GameCatalogItem[] }) {
  const rowHeight = 44;
  const virtualList = useFixedVirtualList({
    itemCount: games.length,
    rowHeight,
    initialViewportHeight: 440,
  });
  const visible = games.slice(virtualList.window.start, virtualList.window.end);
  return (
    <div
      ref={virtualList.containerRef}
      className="catalog-table virtual-catalog-table"
      role="table"
      aria-label="수집 경기 목록"
      onScroll={virtualList.onScroll}
    >
      {games.length === 0 ? (
        <p className="muted-text list-message">저장된 수집 결과가 없습니다.</p>
      ) : (
        <div className="catalog-virtual-spacer" style={{ height: virtualList.window.totalHeight }}>
          {visible.map((game, offset) => {
            const index = virtualList.window.start + offset;
            return (
              <div
                className="catalog-row catalog-virtual-row"
                role="row"
                aria-rowindex={index + 1}
                key={`${game.authority}:${game.gameId}`}
                style={{ transform: `translateY(${String(index * rowHeight)}px)` }}
              >
                <span className="mono-text">{game.gameId}</span>
                <span>{authorityLabel(game.authority)}</span>
                <span>차단 {game.blockingFindings}</span>
                <time dateTime={game.updatedAt}>{formatDateTime(game.updatedAt)}</time>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JobRow({
  job,
  onCancel,
}: {
  readonly job: CollectionJob;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const total = job.totalItems ?? 0;
  const percent = total === 0 ? 0 : Math.round((job.completedItems / total) * 100);
  return (
    <article className="job-row">
      <div className="job-main">
        <div>
          <strong>{statusLabel(job.status)}</strong>
          <span className="mono-text">{job.jobId.slice(0, 8)}</span>
        </div>
        <span>
          {job.completedItems} / {job.totalItems ?? "—"}
        </span>
      </div>
      <div className="progress-track" aria-label={`진행률 ${String(percent)}%`}>
        <span style={{ width: `${String(percent)}%` }} />
      </div>
      <div className="job-summary">
        <span>ready {job.summary.ready}</span>
        <span>quarantine {job.summary.quarantined}</span>
        <span>source failure {job.summary.sourceFailures}</span>
        {job.currentGameId !== null ? <span className="mono-text">{job.currentGameId}</span> : null}
        {!terminal.has(job.status) ? (
          <button className="secondary-button" onClick={onCancel}>
            취소
          </button>
        ) : null}
      </div>
      {job.error !== null ? <div className="inline-error">{job.error}</div> : null}
    </article>
  );
}

function useJobEvents(
  jobs: readonly CollectionJob[],
  invalidate: (event: JobEvent) => Promise<void>,
): void {
  const jobIds = jobs
    .map((job) => job.jobId)
    .sort()
    .join(",");
  useEffect(() => {
    if (jobIds === "") return;
    const streams = jobIds.split(",").map((jobId) => {
      const stream = new EventSource(`/api/v2/collection-jobs/${encodeURIComponent(jobId)}/events`);
      stream.onmessage = (message) => {
        try {
          void invalidate(decodeCollectionJobEvent(message.data));
        } catch {
          // The 2-second job poll remains the recovery path for a malformed or truncated SSE event.
        }
      };
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [invalidate, jobIds]);
}

function todayInLocalTimezone(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function statusLabel(status: CollectionJob["status"]): string {
  return {
    queued: "대기",
    running: "수집 중",
    cancelling: "취소 중",
    cancelled: "취소됨",
    succeeded: "완료",
    failed: "실패",
  }[status];
}

function authorityLabel(
  authority: "staging" | "quarantine" | "source_failure" | "database",
): string {
  return {
    staging: "적재 가능",
    quarantine: "검토 필요",
    source_failure: "원천 실패",
    database: "DB 저장",
  }[authority];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}
