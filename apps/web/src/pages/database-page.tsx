import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DatabaseGameCatalogItem, ImportJob, ImportReadyBatchCreated } from "@kbo/contracts";

import {
  createImportJob,
  createReadyImportBatch,
  createCollectionJob,
  reopenRevisionDraft,
} from "../api/client";
import {
  catalogQueryOptions,
  databaseOverviewQueryOptions,
  importJobsQueryOptions,
  queryKeys,
  revisionCatalogQueryOptions,
} from "../api/query-options";
import { StatusBadge } from "../components/status-badge";
import { useFixedVirtualList } from "../components/use-fixed-virtual-list";
import { WorkspaceTabs } from "../components/workspace-tabs";

const terminal = new Set<ImportJob["status"]>(["cancelled", "succeeded", "failed"]);

export function DatabasePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<ImportReadyBatchCreated | null>(null);
  const [storedLimit, setStoredLimit] = useState(50);
  const [selectedView, setSelectedView] = useState<"ready" | "jobs" | "stored" | null>(null);
  const overview = useQuery(databaseOverviewQueryOptions());
  const catalog = useQuery(catalogQueryOptions());
  const jobs = useQuery({
    ...importJobsQueryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminal.has(job.status)) === true ? 1_000 : false,
  });
  const singleMutation = useMutation({
    mutationFn: createImportJob,
    onSuccess: async () => {
      setSelectedView("jobs");
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.import });
    },
  });
  const batchMutation = useMutation({
    mutationFn: createReadyImportBatch,
    onSuccess: async (result) => {
      setBatchResult(result);
      setConfirmBatch(false);
      setSelectedView("jobs");
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.import });
    },
  });
  const ready = catalog.data?.games.filter((game) => game.authority === "staging") ?? [];
  const stored = catalog.data?.games.filter((game) => game.authority === "database") ?? [];
  const jobsById = new Map(jobs.data?.map((job) => [job.jobId, job]) ?? []);
  const activeGameIds = new Set([
    ...(jobs.data?.filter((job) => !terminal.has(job.status)).map((job) => job.gameId) ?? []),
    ...(batchResult?.jobs.flatMap((created) => {
      const current = jobsById.get(created.jobId);
      return current === undefined || !terminal.has(current.status) ? [created.gameId] : [];
    }) ?? []),
  ]);
  const batchCandidates = ready.filter((game) => !activeGameIds.has(game.gameId));
  const activeView =
    selectedView ?? (activeGameIds.size > 0 ? "jobs" : ready.length > 0 ? "ready" : "stored");
  const batchProgress = summarizeBatch(batchResult, jobsById);
  const completedSignature =
    jobs.data
      ?.filter((job) => terminal.has(job.status))
      .map((job) => `${job.jobId}:${job.status}`)
      .join(",") ?? "";

  useEffect(() => {
    if (completedSignature === "") return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.databaseOverview }),
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
    ]);
  }, [completedSignature, queryClient]);

  return (
    <div className="page-stack database-page">
      <header className="page-header">
        <div>
          <h1>데이터베이스</h1>
          <p>검증이 끝난 staging 문서를 새 불변 revision으로 적재합니다.</p>
        </div>
        {overview.data !== undefined ? (
          <StatusBadge
            healthy={overview.data.database.healthy}
            healthyLabel="DB 정상"
            unhealthyLabel="DB 확인 필요"
          />
        ) : null}
      </header>

      {overview.error !== null ? <div className="error-panel">{overview.error.message}</div> : null}
      <section className="metric-grid database-metrics" aria-label="적재 현황">
        <article className="metric-card">
          <span>적재 가능</span>
          <div>
            <strong>{overview.data?.counts.readyToImport ?? 0}</strong>
            <small>경기</small>
          </div>
        </article>
        <article className="metric-card">
          <span>DB 저장</span>
          <div>
            <strong>{overview.data?.counts.stored ?? 0}</strong>
            <small>경기</small>
          </div>
        </article>
      </section>

      <section className="panel operation-workspace database-workspace">
        <WorkspaceTabs
          activeTab={activeView}
          ariaLabel="데이터베이스 작업공간"
          idPrefix="database"
          onChange={setSelectedView}
          tabs={[
            { id: "ready", label: "적재 대기", count: ready.length },
            { id: "jobs", label: "적재 작업", count: jobs.data?.length ?? 0 },
            { id: "stored", label: "저장된 경기", count: stored.length },
          ]}
        />

        {activeView === "ready" ? (
          <div
            className="operation-workspace-panel operation-workspace-scroll"
            id="database-panel-ready"
            role="tabpanel"
            aria-labelledby="database-tab-ready"
          >
            <div className="section-heading import-ready-heading">
              <p className="muted-text">
                차단 finding이 없는 신규 경기와 revision 교정 초안을 표시합니다.
              </p>
              <button
                className="primary-button"
                type="button"
                disabled={
                  batchCandidates.length === 0 ||
                  batchMutation.isPending ||
                  overview.data?.database.healthy !== true
                }
                onClick={() => setConfirmBatch(true)}
              >
                적재 가능한 {String(batchCandidates.length)}경기 일괄 적재
              </button>
            </div>
            {confirmBatch ? (
              <div className="import-batch-confirmation" role="alert">
                <div>
                  <strong>{String(batchCandidates.length)}경기를 일괄 적재하시겠습니까?</strong>
                  <p>
                    서버가 실행 시점의 적재 가능 문서를 다시 확인합니다. 각 경기는 독립
                    transaction으로 처리되어 한 경기의 실패가 나머지 작업을 중단하지 않습니다.
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={batchMutation.isPending}
                  onClick={() => setConfirmBatch(false)}
                >
                  취소
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={batchMutation.isPending || batchCandidates.length === 0}
                  onClick={() => batchMutation.mutate()}
                >
                  {batchMutation.isPending ? "작업 등록 중" : "일괄 적재 시작"}
                </button>
              </div>
            ) : null}
            <div className="database-list">
              {ready.map((game) => {
                const active = activeGameIds.has(game.gameId);
                return (
                  <article className="database-row" key={game.gameId}>
                    <div>
                      <strong className="mono-text database-game-id">{game.gameId}</strong>
                      <span>{game.season ?? "시즌 미상"}</span>
                    </div>
                    <span>경고 {game.warningFindings}</span>
                    <time dateTime={game.updatedAt}>{formatDateTime(game.updatedAt)}</time>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        active ||
                        singleMutation.isPending ||
                        batchMutation.isPending ||
                        overview.data?.database.healthy !== true
                      }
                      onClick={() => singleMutation.mutate(game.gameId)}
                    >
                      {active ? "적재 중" : "새 revision 적재"}
                    </button>
                  </article>
                );
              })}
              {ready.length === 0 ? (
                <p className="muted-text list-message">적재할 경기가 없습니다.</p>
              ) : null}
            </div>
            {singleMutation.error !== null ? (
              <div className="inline-error">{singleMutation.error.message}</div>
            ) : null}
            {batchMutation.error !== null ? (
              <div className="inline-error">{batchMutation.error.message}</div>
            ) : null}
          </div>
        ) : null}

        {activeView === "jobs" ? (
          <div
            className="operation-workspace-panel database-jobs-panel"
            id="database-panel-jobs"
            role="tabpanel"
            aria-labelledby="database-tab-jobs"
          >
            <div>
              {batchProgress !== null ? (
                <div className="import-batch-progress" role="status" aria-live="polite">
                  <strong>최근 일괄 적재</strong>
                  <span>등록 {String(batchProgress.total)}</span>
                  <span>완료 {String(batchProgress.succeeded)}</span>
                  <span>실패 {String(batchProgress.failed)}</span>
                  <span>진행·대기 {String(batchProgress.pending)}</span>
                  {batchProgress.skipped > 0 ? (
                    <span>이미 저장·진행 중 제외 {String(batchProgress.skipped)}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <ImportJobList jobs={jobs.data ?? []} />
          </div>
        ) : null}

        {activeView === "stored" ? (
          <div
            className="operation-workspace-panel operation-workspace-scroll database-stored-panel"
            id="database-panel-stored"
            role="tabpanel"
            aria-labelledby="database-tab-stored"
          >
            <p className="muted-text database-workspace-note">seal된 current revision</p>
            <div className="database-list">
              {stored.slice(0, storedLimit).map((game) => (
                <StoredGameRow key={game.gameId} game={game} />
              ))}
              {stored.length === 0 ? (
                <p className="muted-text list-message">저장된 경기가 없습니다.</p>
              ) : null}
            </div>
            {storedLimit < stored.length ? (
              <button
                type="button"
                className="secondary-button progressive-list-more"
                onClick={() => setStoredLimit((current) => Math.min(current + 50, stored.length))}
              >
                50경기 더 보기 ({String(stored.length - storedLimit)}경기 남음)
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ImportJobList({ jobs }: { readonly jobs: readonly ImportJob[] }): React.JSX.Element {
  const rowHeight = 72;
  const virtualList = useFixedVirtualList({
    itemCount: jobs.length,
    rowHeight,
    initialViewportHeight: 480,
  });
  const visible = jobs.slice(virtualList.window.start, virtualList.window.end);
  return (
    <div
      ref={virtualList.containerRef}
      className="database-list virtual-import-job-list operation-workspace-list"
      role="list"
      aria-label="적재 작업 목록"
      onScroll={virtualList.onScroll}
    >
      {jobs.length === 0 ? (
        <p className="muted-text list-message">적재 작업이 없습니다.</p>
      ) : (
        <div className="database-virtual-spacer" style={{ height: virtualList.window.totalHeight }}>
          {visible.map((job, offset) => {
            const index = virtualList.window.start + offset;
            return (
              <article
                className="database-row import-job-row database-virtual-row"
                role="listitem"
                key={job.jobId}
                style={{ transform: `translateY(${String(index * rowHeight)}px)` }}
              >
                <div>
                  <strong>{importStatusLabel(job.status)}</strong>
                  <span className="mono-text">{job.gameId}</span>
                </div>
                <span>
                  {job.revision === null ? "revision -" : `revision ${String(job.revision)}`}
                </span>
                <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
                <span className="mono-text hash-cell">
                  {job.projectionHash === null ? "-" : job.projectionHash.slice(0, 12)}
                </span>
                {job.error !== null ? (
                  <div className="inline-error row-error" title={job.error}>
                    {job.error}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StoredGameRow({ game }: { readonly game: DatabaseGameCatalogItem }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const revisions = useQuery({
    ...revisionCatalogQueryOptions(game.gameId),
    enabled: expanded,
  });
  const reopen = useMutation({
    mutationFn: () => reopenRevisionDraft(game.gameId, game.currentRevision),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
    },
  });
  const recollect = useMutation({
    mutationFn: () =>
      createCollectionJob({
        scope: { kind: "game_ids", gameIds: [game.gameId] },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.collection });
    },
  });
  return (
    <article className="database-row stored-game-row database-revision-row">
      <div>
        <strong className="mono-text database-game-id">{game.gameId}</strong>
        <span>
          {game.gameDate} · {game.teams.away.name} @ {game.teams.home.name}
        </span>
      </div>
      <span>
        current revision {game.currentRevision} · 전체 {String(game.revisionCount)}개
      </span>
      <time dateTime={game.updatedAt}>{formatDateTime(game.updatedAt)}</time>
      <div className="database-revision-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={reopen.isPending}
          onClick={() => reopen.mutate()}
        >
          {reopen.isPending ? "초안 생성 중" : "current 교정 초안 열기"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={recollect.isPending}
          onClick={() => recollect.mutate()}
        >
          {recollect.isPending ? "등록 중" : "Naver 원천 재수집"}
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "revision 이력 닫기" : "revision 이력 보기"}
        </button>
      </div>
      {expanded && revisions.isLoading ? (
        <span className="muted-text">이력 불러오는 중</span>
      ) : null}
      {expanded && revisions.data !== undefined ? (
        <div className="revision-history" aria-label={`${game.gameId} revision history`}>
          {revisions.data.revisions.map((revision) => (
            <span key={revision.revision} className={revision.current ? "current" : undefined}>
              r{String(revision.revision)} · {revision.documentHash.slice(0, 10)}
              {revision.current ? " · current" : ""}
            </span>
          ))}
        </div>
      ) : null}
      {revisions.error !== null ? (
        <div className="inline-error">{revisions.error.message}</div>
      ) : null}
      {reopen.error !== null ? <div className="inline-error">{reopen.error.message}</div> : null}
      {recollect.error !== null ? (
        <div className="inline-error">{recollect.error.message}</div>
      ) : null}
    </article>
  );
}

function importStatusLabel(status: ImportJob["status"]): string {
  return {
    queued: "대기",
    running: "적재 중",
    cancelling: "취소 중",
    cancelled: "취소됨",
    succeeded: "완료",
    failed: "실패",
  }[status];
}

interface ImportBatchProgress {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly pending: number;
  readonly skipped: number;
}

function summarizeBatch(
  batch: ImportReadyBatchCreated | null,
  jobsById: ReadonlyMap<string, ImportJob>,
): ImportBatchProgress | null {
  if (batch === null) return null;
  let succeeded = 0;
  let failed = 0;
  for (const created of batch.jobs) {
    const status = jobsById.get(created.jobId)?.status ?? created.status;
    if (status === "succeeded") succeeded += 1;
    else if (status === "failed" || status === "cancelled") failed += 1;
  }
  return {
    total: batch.createdCount,
    succeeded,
    failed,
    pending: batch.createdCount - succeeded - failed,
    skipped: batch.skippedCount,
  };
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}
