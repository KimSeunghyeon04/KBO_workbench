import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import type {
  CatalogAuthority,
  CollectionJob,
  CollectionJobCreateRequest,
  GameCatalogItem,
  JobEvent,
} from "@kbo/contracts";

import { cancelCollectionJob, createCollectionJob, createCorrectionSession } from "../api/client";
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
import { OperationConsole, OperationEmptyDetail } from "../components/operation-console";
import { SelectableVirtualList } from "../components/selectable-virtual-list";

const terminal = new Set<CollectionJob["status"]>(["cancelled", "succeeded", "failed"]);
const authorities = new Set<CatalogAuthority>([
  "staging",
  "quarantine",
  "source_failure",
  "database",
]);

export function CollectPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [pending, startTransition] = useTransition();
  const today = useMemo(todayInLocalTimezone, []);
  const [mode, setMode] = useState<"date_range" | "season">("date_range");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [season, setSeason] = useState(today.slice(0, 4));
  const [historyOpen, setHistoryOpen] = useState(false);
  const jobs = useQuery({
    ...collectionJobsQueryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminal.has(job.status)) === true ? 2_000 : false,
  });
  const catalog = useQuery(catalogQueryOptions());
  const activeJobs = jobs.data?.filter((job) => !terminal.has(job.status)) ?? [];
  const activeJob = activeJobs[0] ?? null;
  const query = searchParams.get("q") ?? "";
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("ko-KR"));
  const authorityValue = searchParams.get("authority");
  const authority =
    authorityValue !== null && authorities.has(authorityValue as CatalogAuthority)
      ? (authorityValue as CatalogAuthority)
      : "all";
  const selectedKind = searchParams.get("kind");
  const selectedId = searchParams.get("selected");
  const selectedGame =
    selectedKind === "game"
      ? (catalog.data?.games.find((game) => game.gameId === selectedId) ?? null)
      : null;
  const selectedJob =
    selectedKind === "job" ? (jobs.data?.find((job) => job.jobId === selectedId) ?? null) : null;
  const filteredGames = useMemo(
    () =>
      (catalog.data?.games ?? []).filter((game) => {
        if (authority !== "all" && game.authority !== authority) return false;
        return deferredQuery === "" || catalogSearchText(game).includes(deferredQuery);
      }),
    [authority, catalog.data?.games, deferredQuery],
  );

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
    onSuccess: async (created) => {
      updateSearch({ kind: "job", selected: created.jobId });
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
  const correctionMutation = useMutation({
    mutationFn: (game: GameCatalogItem) => {
      if (game.authority !== "staging" && game.authority !== "quarantine") {
        throw new Error("보정 가능한 workspace 경기가 아닙니다.");
      }
      return createCorrectionSession(game.authority, game.gameId);
    },
    onSuccess: (session) => {
      void navigate(`/correct?sessionId=${encodeURIComponent(session.sessionId)}`);
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
    <div className="page-stack operation-page collect-page">
      <header className="page-header operation-page-header">
        <div>
          <h1>경기 수집</h1>
          <p>수집 범위를 실행하고 경기별 현재 권위를 확인합니다.</p>
        </div>
        <div className="operation-status-line" aria-live="polite">
          <span>
            전체 <strong>{String(catalog.data?.games.length ?? 0)}</strong>
          </span>
          <span>
            실행 중 <strong>{String(activeJobs.length)}</strong>
          </span>
          <button type="button" className="secondary-button" onClick={() => setHistoryOpen(true)}>
            활동 기록 {String(jobs.data?.length ?? 0)}
          </button>
        </div>
      </header>

      <div className="operation-command-bar collection-command-bar">
        <form onSubmit={submit}>
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
      </div>

      {activeJob !== null ? (
        <ActiveCollectionJob
          job={activeJob}
          cancelling={cancelMutation.isPending}
          onOpen={() => updateSearch({ kind: "job", selected: activeJob.jobId })}
          onCancel={() => cancelMutation.mutate(activeJob.jobId)}
        />
      ) : null}
      {createMutation.error !== null ? (
        <div className="inline-error">{createMutation.error.message}</div>
      ) : null}

      <OperationConsole
        selected={selectedGame !== null || selectedJob !== null}
        onBack={() => updateSearch({ kind: null, selected: null })}
        master={
          <>
            <div className="operation-list-toolbar">
              <label className="operation-search">
                <span>경기 검색</span>
                <input
                  type="search"
                  placeholder="날짜·팀·경기 ID"
                  value={query}
                  onChange={(event) => updateSearch({ q: event.target.value }, true)}
                />
              </label>
              <label>
                <span>현재 상태</span>
                <select
                  value={authority}
                  onChange={(event) =>
                    updateSearch({
                      authority: event.target.value === "all" ? null : event.target.value,
                    })
                  }
                >
                  <option value="all">전체</option>
                  <option value="staging">적재 가능</option>
                  <option value="quarantine">검토 필요</option>
                  <option value="source_failure">원천 실패</option>
                  <option value="database">DB 저장</option>
                </select>
              </label>
            </div>
            <SelectableVirtualList
              ariaLabel="수집 경기 목록"
              emptyMessage={
                catalog.isLoading ? "경기를 불러오는 중입니다." : "조건에 맞는 경기가 없습니다."
              }
              getKey={(game) => `${game.authority}-${game.gameId}`}
              items={filteredGames}
              rowHeight={72}
              selectedKey={
                selectedGame === null ? null : `${selectedGame.authority}-${selectedGame.gameId}`
              }
              onSelect={(game) => updateSearch({ kind: "game", selected: game.gameId })}
              renderItem={(game) => <CatalogRow game={game} />}
            />
          </>
        }
        detail={
          selectedGame !== null ? (
            <CollectionGameDetail
              game={selectedGame}
              pending={correctionMutation.isPending || createMutation.isPending || pending}
              error={correctionMutation.error?.message ?? null}
              onCorrect={() => correctionMutation.mutate(selectedGame)}
              onDatabase={() =>
                void navigate(
                  `/database?scope=stored&game=${encodeURIComponent(selectedGame.gameId)}`,
                )
              }
              onRecollect={() =>
                createMutation.mutate({
                  scope: { kind: "game_ids", gameIds: [selectedGame.gameId] },
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            />
          ) : selectedJob !== null ? (
            <CollectionJobDetail
              job={selectedJob}
              onCancel={() => cancelMutation.mutate(selectedJob.jobId)}
            />
          ) : (
            <OperationEmptyDetail
              title="경기 또는 작업을 선택하세요"
              description="목록에서 경기를 선택하면 상태와 다음 작업을 한곳에서 확인할 수 있습니다."
            />
          )
        }
      />

      {historyOpen ? (
        <>
          <button
            type="button"
            className="operation-drawer-backdrop"
            aria-label="활동 기록 닫기"
            onClick={() => setHistoryOpen(false)}
          />
          <aside className="operation-drawer" aria-label="수집 활동 기록">
            <div className="operation-drawer-header">
              <div>
                <strong>수집 활동 기록</strong>
                <div className="muted-text">요청 범위와 처리 결과</div>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setHistoryOpen(false)}
              >
                닫기
              </button>
            </div>
            <SelectableVirtualList
              ariaLabel="수집 작업 목록"
              emptyMessage="아직 실행한 작업이 없습니다."
              getKey={(job) => job.jobId}
              items={jobs.data ?? []}
              rowHeight={78}
              selectedKey={selectedJob?.jobId ?? null}
              onSelect={(job) => {
                updateSearch({ kind: "job", selected: job.jobId });
                setHistoryOpen(false);
              }}
              renderItem={(job) => <JobRow job={job} />}
            />
          </aside>
        </>
      ) : null}
    </div>
  );
}

function CatalogRow({ game }: { readonly game: GameCatalogItem }): React.JSX.Element {
  return (
    <>
      <span className="operation-row-heading">
        <strong>
          {game.authority === "source_failure"
            ? game.gameId
            : `${game.teams.away.name} vs ${game.teams.home.name}`}
        </strong>
        <span className={`authority-mark ${game.authority}`}>{authorityLabel(game.authority)}</span>
      </span>
      <span className="operation-row-meta">
        <span>{game.authority === "source_failure" ? "경기 정보 미확인" : game.gameDate}</span>
        <time dateTime={game.updatedAt}>{formatDateTime(game.updatedAt)}</time>
      </span>
      <span className="mono-text operation-row-copy">{game.gameId}</span>
    </>
  );
}

function CollectionGameDetail(props: {
  readonly game: GameCatalogItem;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCorrect: () => void;
  readonly onDatabase: () => void;
  readonly onRecollect: () => void;
}): React.JSX.Element {
  const { game } = props;
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>
            {game.authority === "source_failure"
              ? "원천 수집 실패"
              : `${game.teams.away.name} vs ${game.teams.home.name}`}
          </h2>
          <p className="mono-text">{game.gameId}</p>
        </div>
        <span className={`authority-mark ${game.authority}`}>{authorityLabel(game.authority)}</span>
      </header>
      <dl className="operation-detail-fields">
        {game.authority !== "source_failure" ? (
          <div>
            <dt>경기일</dt>
            <dd>{game.gameDate}</dd>
          </div>
        ) : null}
        <div>
          <dt>현재 권위</dt>
          <dd>{authorityLabel(game.authority)}</dd>
        </div>
        <div>
          <dt>갱신 시각</dt>
          <dd>{formatDateTime(game.updatedAt)}</dd>
        </div>
        <div>
          <dt>finding</dt>
          <dd>
            차단 {String(game.blockingFindings)} · 경고 {String(game.warningFindings)}
          </dd>
        </div>
        {game.authority === "database" ? (
          <div>
            <dt>revision</dt>
            <dd>
              current {String(game.currentRevision)} · 전체 {String(game.revisionCount)}
            </dd>
          </div>
        ) : (
          <div>
            <dt>이전 사본</dt>
            <dd>{String(game.supersededCount)}개</dd>
          </div>
        )}
      </dl>
      {props.error !== null ? <div className="inline-error">{props.error}</div> : null}
      <div className="operation-detail-actions">
        {game.authority === "staging" || game.authority === "quarantine" ? (
          <button
            type="button"
            className="primary-button"
            disabled={props.pending}
            onClick={props.onCorrect}
          >
            보정 작업 사본 열기
          </button>
        ) : null}
        {game.authority === "source_failure" ? (
          <button
            type="button"
            className="primary-button"
            disabled={props.pending}
            onClick={props.onRecollect}
          >
            이 경기 다시 수집
          </button>
        ) : null}
        {game.authority === "database" ? (
          <button type="button" className="primary-button" onClick={props.onDatabase}>
            데이터베이스에서 보기
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ActiveCollectionJob({
  job,
  cancelling,
  onCancel,
  onOpen,
}: {
  readonly job: CollectionJob;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const total = job.totalItems ?? 0;
  const percent = total === 0 ? 0 : Math.round((job.completedItems / total) * 100);
  return (
    <section className="active-operation-banner" aria-live="polite">
      <button type="button" className="active-operation-copy" onClick={onOpen}>
        <strong>
          {scopeLabel(job)} · {statusLabel(job.status)}
        </strong>
        <span>
          {job.completedItems} / {job.totalItems ?? "—"}
          {job.currentGameId === null ? "" : ` · ${job.currentGameId}`}
        </span>
      </button>
      <div className="progress-track">
        <span style={{ width: `${String(percent)}%` }} />
      </div>
      <button type="button" className="secondary-button" disabled={cancelling} onClick={onCancel}>
        취소
      </button>
    </section>
  );
}

function JobRow({ job }: { readonly job: CollectionJob }): React.JSX.Element {
  return (
    <>
      <span className="operation-row-heading">
        <strong>{scopeLabel(job)}</strong>
        <span>{statusLabel(job.status)}</span>
      </span>
      <span className="operation-row-meta">
        <span>
          {job.completedItems} / {job.totalItems ?? "—"}
        </span>
        <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
      </span>
      <span className="operation-row-copy">
        적재 가능 {job.summary.ready} · 검토 {job.summary.quarantined} · 실패{" "}
        {job.summary.sourceFailures}
      </span>
    </>
  );
}

function CollectionJobDetail({
  job,
  onCancel,
}: {
  readonly job: CollectionJob;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>{scopeLabel(job)}</h2>
          <p className="mono-text">{job.jobId}</p>
        </div>
        <span className="phase-label">{statusLabel(job.status)}</span>
      </header>
      <dl className="operation-detail-fields">
        <div>
          <dt>요청 범위</dt>
          <dd>{scopeDescription(job)}</dd>
        </div>
        <div>
          <dt>진행</dt>
          <dd>
            {String(job.completedItems)} / {job.totalItems ?? "확인 중"}
          </dd>
        </div>
        <div>
          <dt>결과</dt>
          <dd>
            적재 가능 {String(job.summary.ready)} · 검토 필요 {String(job.summary.quarantined)} ·
            원천 실패 {String(job.summary.sourceFailures)} · 건너뜀 {String(job.skippedItems)}
          </dd>
        </div>
        <div>
          <dt>시작</dt>
          <dd>{job.startedAt === null ? "대기 중" : formatDateTime(job.startedAt)}</dd>
        </div>
        <div>
          <dt>종료</dt>
          <dd>{job.finishedAt === null ? "—" : formatDateTime(job.finishedAt)}</dd>
        </div>
      </dl>
      {job.error !== null ? <div className="inline-error">{job.error}</div> : null}
      {!terminal.has(job.status) ? (
        <div className="operation-detail-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            작업 취소
          </button>
        </div>
      ) : null}
    </div>
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
          // Polling remains the recovery path for malformed or truncated SSE events.
        }
      };
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [invalidate, jobIds]);
}

function catalogSearchText(game: GameCatalogItem): string {
  return [
    game.gameId,
    game.season ?? "",
    game.authority,
    ...(game.authority === "source_failure"
      ? []
      : [game.gameDate, game.teams.away.name, game.teams.home.name]),
  ]
    .join(" ")
    .toLocaleLowerCase("ko-KR");
}

function scopeLabel(job: CollectionJob): string {
  return job.scope.kind === "date_range"
    ? `${job.scope.startDate}–${job.scope.endDate}`
    : `${String(job.scope.gameIds.length)}경기 지정`;
}

function scopeDescription(job: CollectionJob): string {
  return job.scope.kind === "date_range"
    ? `${job.scope.startDate}부터 ${job.scope.endDate}까지`
    : job.scope.gameIds.join(", ");
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

function authorityLabel(authority: CatalogAuthority): string {
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
