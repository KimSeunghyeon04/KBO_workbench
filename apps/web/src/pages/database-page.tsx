import { useCallback, useEffect, useMemo, useState } from "react";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  DatabaseGameCatalogItem,
  ImportJob,
  ImportSelection,
  ImportSelectionRequest,
  WorkspaceDocumentGameCatalogItem,
} from "@kbo/contracts";
import {
  createCollectionJob,
  createImportJob,
  createReadyImportBatch,
  reopenRevisionDraft,
} from "../api/client";
import {
  createImportSelection,
  getDatabaseGames,
  getImportHistory,
  getImportJob,
  cancelImportBatch,
  reconcileImportJob,
} from "../api/import-client";
import {
  databaseOverviewQueryOptions,
  queryKeys,
  revisionCatalogQueryOptions,
} from "../api/query-options";
import { OperationConsole, OperationEmptyDetail } from "../components/operation-console";
import { SelectableVirtualList } from "../components/selectable-virtual-list";
import { StatusBadge } from "../components/status-badge";
import { createRequestKey } from "../api/request-key";

type DatabaseScope = "ready" | "stored" | "jobs";
type ReadyGame = Omit<WorkspaceDocumentGameCatalogItem, "authority"> & {
  readonly authority: "staging";
};
const terminal = new Set<ImportJob["status"]>(["cancelled", "succeeded", "failed"]);

export function DatabasePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selection, setSelection] = useState<ImportSelection | null>(null);
  const [executionKey, setExecutionKey] = useState(createRequestKey);
  const overview = useQuery(databaseOverviewQueryOptions());
  const scopeValue = searchParams.get("scope");
  const scope: DatabaseScope =
    scopeValue === "ready" || scopeValue === "stored" || scopeValue === "jobs"
      ? scopeValue
      : (overview.data?.counts.readyToImport ?? 0) > 0
        ? "ready"
        : "stored";
  const query = searchParams.get("q") ?? "";
  const season = searchParams.get("season") ?? "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const batchId = searchParams.get("batch");
  const resultFilter = searchParams.get("result");
  const selectedGameId = searchParams.get("game");
  const selectedJobId = searchParams.get("job");
  const criteria = useMemo(
    () => ({
      ...(season === "all" ? {} : { season: Number(season) }),
      ...(query.trim() === "" ? {} : { search: query.trim() }),
    }),
    [season, query],
  );
  const gamesQuery = {
    ...criteria,
    authority: scope === "ready" ? ("staging" as const) : ("database" as const),
    page,
    limit: 50,
  };
  const catalog = useQuery({
    queryKey: [...queryKeys.catalog, "database", gamesQuery],
    queryFn: ({ signal }) => getDatabaseGames(gamesQuery, signal),
    enabled: scope !== "jobs",
  });
  const historyQuery = {
    page: scope === "jobs" ? page : 1,
    limit: 50,
    ...(scope === "jobs" && query.trim() !== "" ? { search: query.trim() } : {}),
    ...(batchId === null ? {} : { batchId }),
    ...(resultFilter === "failed"
      ? { status: "failed" as const }
      : resultFilter === "cancelled"
        ? { status: "cancelled" as const }
        : {}),
  };
  const history = useQuery({
    queryKey: [...queryKeys.jobs.import, "history", historyQuery],
    queryFn: ({ signal }) => getImportHistory(historyQuery, signal),
    refetchInterval: (entry) =>
      (entry.state.data?.summary.queued ?? 0) +
        (entry.state.data?.summary.running ?? 0) +
        (entry.state.data?.activeJobs?.length ?? 0) >
      0
        ? 1_000
        : false,
  });
  const jobDetail = useQuery({
    queryKey: [...queryKeys.jobs.import, "detail", selectedJobId],
    queryFn: ({ signal }) => getImportJob(selectedJobId ?? "", signal),
    enabled: scope === "jobs" && selectedJobId !== null,
    refetchInterval: (entry) =>
      entry.state.data !== undefined &&
      (!terminal.has(entry.state.data.status) ||
        (entry.state.data.followUpPending === true && entry.state.data.error === null))
        ? 1_000
        : false,
  });
  const ready = (catalog.data?.games ?? []).filter(
    (game): game is ReadyGame => game.authority === "staging",
  );
  const stored = (catalog.data?.games ?? []).filter(
    (game): game is DatabaseGameCatalogItem => game.authority === "database",
  );
  const selectedReady =
    scope === "ready" ? (ready.find((game) => game.gameId === selectedGameId) ?? null) : null;
  const selectedStored =
    scope === "stored" ? (stored.find((game) => game.gameId === selectedGameId) ?? null) : null;
  const candidateJob = scope === "jobs" && selectedJobId !== null ? (jobDetail.data ?? null) : null;
  const selectedJob =
    candidateJob !== null &&
    (batchId === null || candidateJob.batchId === batchId) &&
    ((resultFilter !== "failed" && resultFilter !== "cancelled") ||
      candidateJob.status === resultFilter) &&
    `${candidateJob.gameId} ${candidateJob.jobId} ${candidateJob.error ?? ""}`
      .toLocaleLowerCase("ko-KR")
      .includes(query.trim().toLocaleLowerCase("ko-KR"))
      ? candidateJob
      : null;
  const summary = history.data?.summary;
  const activeGameIds = new Set(
    [...(history.data?.activeJobs ?? []), ...(history.data?.jobs ?? [])]
      .filter(
        (job) => !terminal.has(job.status) || (job.followUpPending === true && job.error === null),
      )
      .map((job) => job.gameId),
  );
  const updateSearch = useCallback(
    (updates: Readonly<Record<string, string | null>>, replace = false) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );
  useEffect(() => {
    if (
      scope !== "jobs" &&
      selectedGameId !== null &&
      catalog.isSuccess &&
      !catalog.isFetching &&
      !catalog.data.games.some((game) => game.gameId === selectedGameId)
    )
      updateSearch({ game: null }, true);
  }, [catalog.data, catalog.isSuccess, catalog.isFetching, scope, selectedGameId, updateSearch]);
  useEffect(() => {
    if (candidateJob !== null && selectedJob === null) updateSearch({ job: null }, true);
  }, [candidateJob, selectedJob, updateSearch]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.import }),
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.databaseOverview }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      queryClient.invalidateQueries({ queryKey: queryKeys.recordCorrections.all }),
    ]);
  };
  const singleMutation = useMutation({
    mutationFn: createImportJob,
    onSuccess: async (created) => {
      updateSearch({
        scope: "jobs",
        game: null,
        job: created.jobId,
        batch: null,
        page: null,
        q: null,
        result: null,
      });
      await refresh();
    },
  });
  const selectMutation = useMutation({
    mutationFn: createImportSelection,
    onSuccess: (value) => {
      setSelection(value);
      setExecutionKey(createRequestKey());
    },
  });
  const batchMutation = useMutation({
    mutationFn: () => {
      if (selection === null) throw new Error("적재 대상을 먼저 선택하세요.");
      return createReadyImportBatch(selection.selectionId, executionKey);
    },
    onSuccess: async (result) => {
      setSelection(null);
      updateSearch({
        scope: "jobs",
        batch: result.batchId,
        game: null,
        job: null,
        page: null,
        q: null,
        result: null,
      });
      await refresh();
    },
  });
  const cancel = useMutation({ mutationFn: cancelImportBatch, onSuccess: refresh });
  const reconcile = useMutation({ mutationFn: reconcileImportJob, onSuccess: refresh });
  const reopen = useMutation({
    mutationFn: (game: DatabaseGameCatalogItem) =>
      reopenRevisionDraft(game.gameId, game.currentRevision),
    onSuccess: async (document) => {
      await refresh();
      void navigate(`/correct?game=${encodeURIComponent(document.metadata.gameId)}`);
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
  const completed = `${summary?.succeeded ?? 0}:${summary?.failed ?? 0}:${summary?.cancelled ?? 0}:${selectedJob?.status ?? ""}:${selectedJob?.followUpPending ?? ""}:${history.data?.activeJobs?.length ?? 0}`;
  useEffect(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.databaseOverview }),
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.recordCorrections.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
    ]);
  }, [completed, queryClient]);
  const error =
    overview.error ??
    catalog.error ??
    history.error ??
    jobDetail.error ??
    singleMutation.error ??
    selectMutation.error ??
    batchMutation.error ??
    cancel.error ??
    reconcile.error ??
    reopen.error ??
    recollect.error;
  const total = scope === "jobs" ? (history.data?.total ?? 0) : (catalog.data?.total ?? 0);
  const pending = scope === "jobs" ? history.isFetching : catalog.isFetching;
  const selected = selectedReady !== null || selectedStored !== null || selectedJob !== null;
  const choose = (value: ImportSelectionRequest) => selectMutation.mutate(value);

  return (
    <div className="page-stack operation-page database-page">
      <header className="page-header operation-page-header">
        <div>
          <h1>데이터베이스</h1>
          <p>검증된 경기를 저장하고 처리 결과를 확인합니다.</p>
        </div>
        <div className="operation-status-line">
          {overview.data === undefined ? null : (
            <StatusBadge
              healthy={overview.data.database.healthy}
              healthyLabel="DB 정상"
              unhealthyLabel="DB 확인 필요"
            />
          )}
          <span>
            적재 대기 <strong>{overview.data?.counts.readyToImport ?? "—"}</strong>
          </span>
          <span>
            저장 경기 <strong>{overview.data?.counts.stored ?? "—"}</strong>
          </span>
        </div>
      </header>
      <div className="operation-command-bar database-command-bar">
        <div>
          <strong>실행 대상</strong>
          <p>
            {selection === null
              ? "목록에서 조건을 확인한 뒤 적재 대상을 선택하세요."
              : `${selection.criteria.gameIds === undefined ? `${selection.criteria.season ?? "전체"} 시즌` : "개별 선택"} · ${selection.criteria.search ? `검색 ‘${selection.criteria.search}’ · ` : ""}${selection.count}경기 확정 · 표시 필터를 바꿔도 유지됩니다.`}
          </p>
        </div>
        {selection === null ? (
          <button
            type="button"
            className="primary-button"
            disabled={scope !== "ready" || total === 0 || pending || selectMutation.isPending}
            onClick={() => choose(criteria)}
          >
            {selectMutation.isPending ? "대상 확인 중" : "현재 조건 전체 선택"}
          </button>
        ) : (
          <div className="operation-detail-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={batchMutation.isPending}
              onClick={() => setSelection(null)}
            >
              선택 해제
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={
                selection.count === 0 ||
                batchMutation.isPending ||
                overview.data?.database.healthy !== true
              }
              onClick={() => batchMutation.mutate()}
            >
              {batchMutation.isPending ? "등록 중" : `${selection.count}경기 일괄 적재 시작`}
            </button>
          </div>
        )}
      </div>
      {summary !== undefined && summary.total > 0 ? (
        <div className="operation-inline-stats" role="status">
          <strong>{batchId === null ? "적재 기록" : "선택한 일괄 작업"}</strong>
          <span>전체 {summary.total}</span>
          <span>완료 {summary.succeeded}</span>
          <span>실패 {summary.failed}</span>
          <span>건너뜀·중단 {summary.cancelled}</span>
          <span>진행 {summary.running}</span>
          <span>대기 {summary.queued}</span>
          {history.data?.activeJobs?.map((job) => (
            <button
              type="button"
              className="text-button"
              key={job.jobId}
              onClick={() =>
                updateSearch({ scope: "jobs", job: job.jobId, q: null, result: null, page: null })
              }
            >
              {job.status === "succeeded" ? "저장 후 정리 중" : "처리 중"} {job.gameId}
            </button>
          ))}
          {batchId !== null && summary.queued > 0 ? (
            <button
              type="button"
              className="secondary-button"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(batchId)}
            >
              대기 경기 취소
            </button>
          ) : null}
          {batchId !== null ? (
            <button
              type="button"
              className="text-button"
              onClick={() => updateSearch({ batch: null, page: null, job: null })}
            >
              전체 작업 기록
            </button>
          ) : null}
        </div>
      ) : null}
      {error === null ? null : <div className="error-panel">{error.message}</div>}
      <OperationConsole
        selected={selected}
        onBack={() => updateSearch({ game: null, job: null })}
        master={
          <>
            <div className="operation-list-toolbar database-list-toolbar">
              <div className="operation-segments" role="group" aria-label="데이터베이스 범위">
                {(
                  [
                    ["ready", "적재 대기", overview.data?.counts.readyToImport ?? 0],
                    ["stored", "저장 경기", overview.data?.counts.stored ?? 0],
                    ["jobs", "작업 기록", summary?.total ?? 0],
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={scope === value}
                    className={scope === value ? "selected" : undefined}
                    onClick={() =>
                      updateSearch({
                        scope: value,
                        game: null,
                        job: null,
                        page: null,
                        q: null,
                        result: null,
                      })
                    }
                  >
                    {label} {count}
                  </button>
                ))}
              </div>
              <label className="operation-search">
                <span>검색</span>
                <input
                  type="search"
                  placeholder={scope === "jobs" ? "경기 ID·작업 ID·오류" : "날짜·팀·경기 ID"}
                  value={query}
                  onChange={(event) =>
                    updateSearch({ q: event.target.value, page: null, game: null, job: null }, true)
                  }
                />
              </label>
              {scope === "jobs" ? (
                <label>
                  <span>결과</span>
                  <select
                    value={resultFilter ?? "all"}
                    onChange={(event) =>
                      updateSearch({
                        result: event.target.value === "all" ? null : event.target.value,
                        job: null,
                        page: null,
                      })
                    }
                  >
                    <option value="all">전체 결과</option>
                    <option value="failed">실패</option>
                    <option value="cancelled">건너뜀·중단</option>
                  </select>
                </label>
              ) : (
                <label>
                  <span>시즌</span>
                  <select
                    value={season}
                    onChange={(event) =>
                      updateSearch({
                        season: event.target.value === "all" ? null : event.target.value,
                        page: null,
                        game: null,
                      })
                    }
                  >
                    <option value="all">전체</option>
                    {catalog.data?.seasons.map((value) => (
                      <option key={value} value={String(value)}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {scope === "ready" ? (
              <SelectableVirtualList
                ariaLabel="적재 대기 경기"
                emptyMessage={pending ? "경기를 불러오는 중입니다." : "적재할 경기가 없습니다."}
                getKey={(game) => game.gameId}
                items={ready}
                rowHeight={84}
                selectedKey={selectedReady?.gameId ?? null}
                onSelect={(game) => updateSearch({ game: game.gameId, job: null })}
                renderItem={(game) => <DatabaseGameRow game={game} label="적재 가능" />}
              />
            ) : scope === "stored" ? (
              <SelectableVirtualList
                ariaLabel="저장된 경기"
                emptyMessage={pending ? "경기를 불러오는 중입니다." : "저장된 경기가 없습니다."}
                getKey={(game) => game.gameId}
                items={stored}
                rowHeight={84}
                selectedKey={selectedStored?.gameId ?? null}
                onSelect={(game) => updateSearch({ game: game.gameId, job: null })}
                renderItem={(game) => (
                  <DatabaseGameRow game={game} label={`r${game.currentRevision}`} />
                )}
              />
            ) : (
              <SelectableVirtualList
                ariaLabel="적재 작업 기록"
                emptyMessage="적재 작업이 없습니다."
                getKey={(job) => job.jobId}
                items={history.data?.jobs ?? []}
                rowHeight={84}
                selectedKey={selectedJob?.jobId ?? null}
                onSelect={(job) => updateSearch({ game: null, job: job.jobId })}
                renderItem={(job) => <ImportJobRow job={job} />}
              />
            )}
            <div className="operation-list-toolbar" aria-label="목록 페이지">
              <button
                type="button"
                className="secondary-button"
                disabled={page <= 1 || pending}
                onClick={() => updateSearch({ page: String(page - 1), game: null, job: null })}
              >
                이전
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil(total / 50))} · {total}건
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={page * 50 >= total || pending}
                onClick={() => updateSearch({ page: String(page + 1), game: null, job: null })}
              >
                다음
              </button>
            </div>
          </>
        }
        detail={
          selectedReady !== null ? (
            <>
              <ReadyGameDetail
                game={selectedReady}
                active={activeGameIds.has(selectedReady.gameId)}
                pending={singleMutation.isPending || batchMutation.isPending}
                databaseHealthy={overview.data?.database.healthy === true}
                onImport={() => singleMutation.mutate(selectedReady.gameId)}
              />
              <div className="operation-detail-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={selectMutation.isPending || batchMutation.isPending}
                  onClick={() => choose({ gameIds: [selectedReady.gameId] })}
                >
                  이 경기만 대상으로 선택
                </button>
                {selection === null ? null : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={selectMutation.isPending || batchMutation.isPending}
                    onClick={() =>
                      choose({
                        ...selection.criteria,
                        selectionId: selection.selectionId,
                        excludedGameIds: [
                          ...new Set([
                            ...(selection.criteria.excludedGameIds ?? []),
                            selectedReady.gameId,
                          ]),
                        ],
                      })
                    }
                  >
                    확정 대상에서 이 경기 제외
                  </button>
                )}
              </div>
            </>
          ) : selectedStored !== null ? (
            <StoredGameDetail
              game={selectedStored}
              pending={reopen.isPending || recollect.isPending}
              onReopen={() => reopen.mutate(selectedStored)}
              onRecollect={() => recollect.mutate(selectedStored.gameId)}
              onReplay={(revision) =>
                void navigate(
                  `/replay?gameId=${encodeURIComponent(selectedStored.gameId)}&revision=${revision}`,
                )
              }
            />
          ) : selectedJob !== null ? (
            <>
              <ImportJobDetail job={selectedJob} />
              {selectedJob.batchId === undefined || selectedJob.batchId === batchId ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    updateSearch({
                      batch: selectedJob.batchId ?? null,
                      page: null,
                      q: null,
                      result: null,
                    })
                  }
                >
                  이 일괄 작업 전체 보기
                </button>
              )}
              {selectedJob.status === "succeeded" ? (
                <div className="operation-detail-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      void navigate(
                        `/replay?gameId=${encodeURIComponent(selectedJob.gameId)}&revision=${selectedJob.revision}`,
                      )
                    }
                  >
                    저장 경기 재생
                  </button>
                  {selectedJob.followUpPending === true && selectedJob.error !== null ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={reconcile.isPending}
                      onClick={() => reconcile.mutate(selectedJob.jobId)}
                    >
                      후속 정리 재시도
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <OperationEmptyDetail
              title="항목을 선택하세요"
              description="경기를 선택하면 보정·적재·재생 동작을 확인할 수 있습니다."
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
