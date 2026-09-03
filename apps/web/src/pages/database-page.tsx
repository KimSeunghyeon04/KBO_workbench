import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import type {
  DatabaseGameCatalogItem,
  ImportJob,
  ImportReadyBatchCreated,
  WorkspaceDocumentGameCatalogItem,
} from "@kbo/contracts";

import {
  createCollectionJob,
  createImportJob,
  createReadyImportBatch,
  reopenRevisionDraft,
} from "../api/client";
import {
  catalogQueryOptions,
  databaseOverviewQueryOptions,
  importJobsQueryOptions,
  queryKeys,
  revisionCatalogQueryOptions,
} from "../api/query-options";
import { OperationConsole, OperationEmptyDetail } from "../components/operation-console";
import { SelectableVirtualList } from "../components/selectable-virtual-list";
import { StatusBadge } from "../components/status-badge";

type DatabaseScope = "ready" | "stored" | "jobs";
type ReadyGame = Omit<WorkspaceDocumentGameCatalogItem, "authority"> & {
  readonly authority: "staging";
};
const scopes = new Set<DatabaseScope>(["ready", "stored", "jobs"]);
const terminal = new Set<ImportJob["status"]>(["cancelled", "succeeded", "failed"]);

export function DatabasePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [, startTransition] = useTransition();
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<ImportReadyBatchCreated | null>(null);
  const overview = useQuery(databaseOverviewQueryOptions());
  const catalog = useQuery(catalogQueryOptions());
  const jobs = useQuery({
    ...importJobsQueryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminal.has(job.status)) === true ? 1_000 : false,
  });
  const ready = useMemo(
    () =>
      catalog.data?.games.filter((game): game is ReadyGame => game.authority === "staging") ?? [],
    [catalog.data?.games],
  );
  const stored = useMemo(
    () =>
      catalog.data?.games.filter(
        (game): game is DatabaseGameCatalogItem => game.authority === "database",
      ) ?? [],
    [catalog.data?.games],
  );
  const scopeValue = searchParams.get("scope");
  const scope =
    scopeValue !== null && scopes.has(scopeValue as DatabaseScope)
      ? (scopeValue as DatabaseScope)
      : ready.length > 0
        ? "ready"
        : "stored";
  const query = searchParams.get("q") ?? "";
  const season = searchParams.get("season") ?? "all";
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("ko-KR"));
  const selectedGameId = searchParams.get("game");
  const selectedJobId = searchParams.get("job");
  const selectedReady =
    scope === "ready" ? (ready.find((game) => game.gameId === selectedGameId) ?? null) : null;
  const selectedStored =
    scope === "stored" ? (stored.find((game) => game.gameId === selectedGameId) ?? null) : null;
  const selectedJob =
    scope === "jobs" ? (jobs.data?.find((job) => job.jobId === selectedJobId) ?? null) : null;
  const activeGameIds = new Set(
    jobs.data?.filter((job) => !terminal.has(job.status)).map((job) => job.gameId) ?? [],
  );
  const batchCandidates = ready.filter((game) => !activeGameIds.has(game.gameId));
  const filteredReady = useMemo(
    () => ready.filter((game) => gameMatches(game, season, deferredQuery)),
    [deferredQuery, ready, season],
  );
  const filteredStored = useMemo(
    () => stored.filter((game) => gameMatches(game, season, deferredQuery)),
    [deferredQuery, season, stored],
  );
  const filteredJobs = useMemo(
    () =>
      (jobs.data ?? []).filter(
        (job) =>
          deferredQuery === "" ||
          `${job.gameId} ${job.status} ${job.jobId}`
            .toLocaleLowerCase("ko-KR")
            .includes(deferredQuery),
      ),
    [deferredQuery, jobs.data],
  );
  const seasons = useMemo(
    () =>
      [
        ...new Set(
          [...ready, ...stored].flatMap((game) => (game.season === null ? [] : [game.season])),
        ),
      ].sort((left, right) => right - left),
    [ready, stored],
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

  const singleMutation = useMutation({
    mutationFn: createImportJob,
    onSuccess: async (created) => {
      updateSearch({ scope: "jobs", game: null, job: created.jobId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.import });
    },
  });
  const batchMutation = useMutation({
    mutationFn: createReadyImportBatch,
    onSuccess: async (result) => {
      setBatchResult(result);
      setConfirmBatch(false);
      updateSearch({ scope: "jobs", game: null, job: result.jobs[0]?.jobId ?? null });
      await queryClient.invalidateQueries({ queryKey: queryKeys.jobs.import });
    },
  });
  const reopen = useMutation({
    mutationFn: (game: DatabaseGameCatalogItem) =>
      reopenRevisionDraft(game.gameId, game.currentRevision),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
      void navigate("/correct");
    },
  });
  const recollect = useMutation({
    mutationFn: (gameId: string) =>
      createCollectionJob({
        scope: { kind: "game_ids", gameIds: [gameId] },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (created) => {
      void navigate(`/collect?kind=job&selected=${encodeURIComponent(created.jobId)}`);
    },
  });
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

  const selected = selectedReady !== null || selectedStored !== null || selectedJob !== null;
  const error =
    overview.error ??
    catalog.error ??
    jobs.error ??
    singleMutation.error ??
    batchMutation.error ??
    reopen.error ??
    recollect.error;

  return (
    <div className="page-stack operation-page database-page">
      <header className="page-header operation-page-header">
        <div>
          <h1>데이터베이스</h1>
          <p>적재할 원장과 봉인된 revision을 한 작업공간에서 관리합니다.</p>
        </div>
        <div className="operation-status-line">
          {overview.data !== undefined ? (
            <StatusBadge
              healthy={overview.data.database.healthy}
              healthyLabel="DB 정상"
              unhealthyLabel="DB 확인 필요"
            />
          ) : null}
          <span>
            적재 대기 <strong>{String(ready.length)}</strong>
          </span>
          <span>
            저장 경기 <strong>{String(stored.length)}</strong>
          </span>
        </div>
      </header>

      <div className="operation-command-bar database-command-bar">
        <div className="operation-status-line database-command-summary">
          <strong>{scopeLabel(scope)}</strong>
          <span>
            {scope === "ready"
              ? "검증된 원장을 새 불변 revision으로 적재합니다."
              : scope === "stored"
                ? "경기를 선택해 revision과 후속 작업을 확인합니다."
                : "적재 처리 결과와 오류를 확인합니다."}
          </span>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={
            batchCandidates.length === 0 ||
            batchMutation.isPending ||
            overview.data?.database.healthy !== true
          }
          onClick={() => setConfirmBatch(true)}
        >
          {String(batchCandidates.length)}경기 일괄 적재
        </button>
      </div>
      {confirmBatch ? (
        <div className="import-batch-confirmation" role="alert">
          <div>
            <strong>{String(batchCandidates.length)}경기를 일괄 적재합니다.</strong>
            <p>
              서버가 실행 시점의 current를 다시 검증하며 각 경기는 독립 transaction으로 처리됩니다.
            </p>
          </div>
          <button type="button" className="secondary-button" onClick={() => setConfirmBatch(false)}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={batchMutation.isPending}
            onClick={() => batchMutation.mutate()}
          >
            {batchMutation.isPending ? "등록 중" : "일괄 적재 시작"}
          </button>
        </div>
      ) : null}
      {batchResult !== null ? (
        <div className="operation-inline-stats" role="status">
          <span>최근 일괄 등록 {String(batchResult.createdCount)}</span>
          <span>제외 {String(batchResult.skippedCount)}</span>
        </div>
      ) : null}
      {error !== null ? <div className="error-panel">{error.message}</div> : null}

      <OperationConsole
        selected={selected}
        onBack={() => updateSearch({ game: null, job: null })}
        master={
          <>
            <div className="operation-list-toolbar database-list-toolbar">
              <div className="operation-segments" aria-label="데이터베이스 범위">
                {(
                  [
                    ["ready", "적재 대기", ready.length],
                    ["stored", "저장 경기", stored.length],
                    ["jobs", "작업 기록", jobs.data?.length ?? 0],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    type="button"
                    className={scope === value ? "selected" : undefined}
                    key={value}
                    onClick={() => updateSearch({ scope: value, game: null, job: null })}
                  >
                    {label} {String(count)}
                  </button>
                ))}
              </div>
              <label className="operation-search">
                <span>검색</span>
                <input
                  type="search"
                  placeholder="날짜·팀·경기 ID"
                  value={query}
                  onChange={(event) => updateSearch({ q: event.target.value }, true)}
                />
              </label>
              {scope !== "jobs" ? (
                <label>
                  <span>시즌</span>
                  <select
                    value={season}
                    onChange={(event) =>
                      updateSearch({
                        season: event.target.value === "all" ? null : event.target.value,
                      })
                    }
                  >
                    <option value="all">전체</option>
                    {seasons.map((value) => (
                      <option key={value} value={String(value)}>
                        {String(value)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {scope === "ready" ? (
              <SelectableVirtualList
                ariaLabel="적재 대기 경기"
                emptyMessage="적재할 경기가 없습니다."
                getKey={(game) => game.gameId}
                items={filteredReady}
                rowHeight={72}
                selectedKey={selectedReady?.gameId ?? null}
                onSelect={(game) => updateSearch({ game: game.gameId, job: null })}
                renderItem={(game) => <DatabaseGameRow game={game} label="적재 가능" />}
              />
            ) : scope === "stored" ? (
              <SelectableVirtualList
                ariaLabel="저장된 경기"
                emptyMessage="저장된 경기가 없습니다."
                getKey={(game) => game.gameId}
                items={filteredStored}
                rowHeight={72}
                selectedKey={selectedStored?.gameId ?? null}
                onSelect={(game) => updateSearch({ game: game.gameId, job: null })}
                renderItem={(game) => (
                  <DatabaseGameRow game={game} label={`r${String(game.currentRevision)}`} />
                )}
              />
            ) : (
              <SelectableVirtualList
                ariaLabel="적재 작업 기록"
                emptyMessage="적재 작업이 없습니다."
                getKey={(job) => job.jobId}
                items={filteredJobs}
                rowHeight={72}
                selectedKey={selectedJob?.jobId ?? null}
                onSelect={(job) => updateSearch({ game: null, job: job.jobId })}
                renderItem={(job) => <ImportJobRow job={job} />}
              />
            )}
          </>
        }
        detail={
          selectedReady !== null ? (
            <ReadyGameDetail
              game={selectedReady}
              active={activeGameIds.has(selectedReady.gameId)}
              pending={singleMutation.isPending || batchMutation.isPending}
              databaseHealthy={overview.data?.database.healthy === true}
              onImport={() => singleMutation.mutate(selectedReady.gameId)}
            />
          ) : selectedStored !== null ? (
            <StoredGameDetail
              game={selectedStored}
              pending={reopen.isPending || recollect.isPending}
              onReopen={() => reopen.mutate(selectedStored)}
              onRecollect={() => recollect.mutate(selectedStored.gameId)}
              onReplay={(revision) =>
                void navigate(
                  `/replay?gameId=${encodeURIComponent(selectedStored.gameId)}&revision=${String(revision)}`,
                )
              }
            />
          ) : selectedJob !== null ? (
            <ImportJobDetail job={selectedJob} />
          ) : (
            <OperationEmptyDetail
              title="항목을 선택하세요"
              description="행마다 버튼을 반복하지 않습니다. 경기나 작업을 선택하면 필요한 행동과 이력을 이곳에 표시합니다."
            />
          )
        }
      />
    </div>
  );
}

function DatabaseGameRow({
  game,
  label,
}: {
  readonly game: ReadyGame | DatabaseGameCatalogItem;
  readonly label: string;
}): React.JSX.Element {
  return (
    <>
      <span className="operation-row-heading">
        <strong>
          {game.teams.away.name} vs {game.teams.home.name}
        </strong>
        <span className="authority-mark database">{label}</span>
      </span>
      <span className="operation-row-meta">
        <span>{game.gameDate}</span>
        <time dateTime={game.updatedAt}>{formatDateTime(game.updatedAt)}</time>
      </span>
      <span className="mono-text operation-row-copy">{game.gameId}</span>
    </>
  );
}

function ImportJobRow({ job }: { readonly job: ImportJob }): React.JSX.Element {
  return (
    <>
      <span className="operation-row-heading">
        <strong>{job.gameId}</strong>
        <span
          className={`authority-mark ${job.status === "failed" ? "source_failure" : "database"}`}
        >
          {importStatusLabel(job.status)}
        </span>
      </span>
      <span className="operation-row-meta">
        <span>{job.revision === null ? "revision —" : `revision ${String(job.revision)}`}</span>
        <time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
      </span>
      <span className="mono-text operation-row-copy">
        {job.projectionHash?.slice(0, 12) ?? job.jobId}
      </span>
    </>
  );
}

function ReadyGameDetail(props: {
  readonly game: ReadyGame;
  readonly active: boolean;
  readonly pending: boolean;
  readonly databaseHealthy: boolean;
  readonly onImport: () => void;
}): React.JSX.Element {
  const { game } = props;
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>
            {game.teams.away.name} vs {game.teams.home.name}
          </h2>
          <p className="mono-text">{game.gameId}</p>
        </div>
        <span className="authority-mark staging">적재 가능</span>
      </header>
      <dl className="operation-detail-fields">
        <div>
          <dt>경기일</dt>
          <dd>{game.gameDate}</dd>
        </div>
        <div>
          <dt>시즌</dt>
          <dd>{game.season ?? "미상"}</dd>
        </div>
        <div>
          <dt>finding</dt>
          <dd>경고 {String(game.warningFindings)}</dd>
        </div>
        <div>
          <dt>갱신</dt>
          <dd>{formatDateTime(game.updatedAt)}</dd>
        </div>
      </dl>
      <div className="operation-detail-actions">
        <button
          type="button"
          className="primary-button"
          disabled={props.active || props.pending || !props.databaseHealthy}
          onClick={props.onImport}
        >
          {props.active ? "적재 중" : "새 revision 적재"}
        </button>
      </div>
    </div>
  );
}

function StoredGameDetail(props: {
  readonly game: DatabaseGameCatalogItem;
  readonly pending: boolean;
  readonly onReopen: () => void;
  readonly onRecollect: () => void;
  readonly onReplay: (revision: number) => void;
}): React.JSX.Element {
  const revisions = useQuery(revisionCatalogQueryOptions(props.game.gameId));
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>
            {props.game.teams.away.name} vs {props.game.teams.home.name}
          </h2>
          <p className="mono-text">{props.game.gameId}</p>
        </div>
        <span className="authority-mark database">
          current r{String(props.game.currentRevision)}
        </span>
      </header>
      <dl className="operation-detail-fields">
        <div>
          <dt>경기일</dt>
          <dd>{props.game.gameDate}</dd>
        </div>
        <div>
          <dt>revision</dt>
          <dd>
            current {String(props.game.currentRevision)} · 전체 {String(props.game.revisionCount)}
          </dd>
        </div>
        <div>
          <dt>최근 갱신</dt>
          <dd>{formatDateTime(props.game.updatedAt)}</dd>
        </div>
      </dl>
      <h3>Revision 이력</h3>
      <div className="database-revision-list">
        {revisions.isLoading ? (
          <p className="muted-text">이력을 불러오는 중입니다.</p>
        ) : (
          revisions.data?.revisions.map((revision) => (
            <button
              type="button"
              key={revision.revision}
              className={revision.current ? "current" : undefined}
              onClick={() => props.onReplay(revision.revision)}
            >
              <strong>r{String(revision.revision)}</strong>
              <span>{revision.current ? "current" : formatDateTime(revision.createdAt)}</span>
              <small>{revision.documentHash.slice(0, 12)}</small>
            </button>
          ))
        )}
      </div>
      {revisions.error !== null ? (
        <div className="inline-error">{revisions.error.message}</div>
      ) : null}
      <div className="operation-detail-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={props.pending}
          onClick={props.onRecollect}
        >
          Naver 원천 재수집
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={props.pending}
          onClick={props.onReopen}
        >
          current 교정 초안 열기
        </button>
      </div>
    </div>
  );
}

function ImportJobDetail({ job }: { readonly job: ImportJob }): React.JSX.Element {
  return (
    <div className="operation-detail-stack">
      <header className="operation-detail-heading">
        <div>
          <h2>{job.gameId}</h2>
          <p className="mono-text">{job.jobId}</p>
        </div>
        <span
          className={`authority-mark ${job.status === "failed" ? "source_failure" : "database"}`}
        >
          {importStatusLabel(job.status)}
        </span>
      </header>
      <dl className="operation-detail-fields">
        <div>
          <dt>revision</dt>
          <dd>{job.revision ?? "—"}</dd>
        </div>
        <div>
          <dt>시작</dt>
          <dd>{job.startedAt === null ? "대기 중" : formatDateTime(job.startedAt)}</dd>
        </div>
        <div>
          <dt>종료</dt>
          <dd>{job.finishedAt === null ? "—" : formatDateTime(job.finishedAt)}</dd>
        </div>
        <div>
          <dt>문서 hash</dt>
          <dd className="mono-text">{job.documentHash ?? "—"}</dd>
        </div>
        <div>
          <dt>projection hash</dt>
          <dd className="mono-text">{job.projectionHash ?? "—"}</dd>
        </div>
      </dl>
      {job.error !== null ? <div className="inline-error">{job.error}</div> : null}
    </div>
  );
}

function gameMatches(
  game: ReadyGame | DatabaseGameCatalogItem,
  season: string,
  query: string,
): boolean {
  if (season !== "all" && String(game.season) !== season) return false;
  if (query === "") return true;
  return `${game.gameId} ${game.gameDate} ${game.teams.away.name} ${game.teams.home.name}`
    .toLocaleLowerCase("ko-KR")
    .includes(query);
}

function scopeLabel(scope: DatabaseScope): string {
  return { ready: "적재 대기", stored: "저장된 경기", jobs: "적재 작업 기록" }[scope];
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}
