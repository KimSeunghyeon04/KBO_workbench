import * as React from "react";
import { useDeferredValue } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CollectionDateRange,
  CollectionDiscovery,
  CollectionGameSummary,
  CollectionSelectionCreate,
} from "@kbo/contracts";
import {
  collectionGamesOptions,
  collectionOperationKey,
  createCollectionSelection,
  overviewOptions,
} from "../api/collection-operations-client";
import { createCollectionJob } from "../api/collection-client";
import { queryKeys } from "../api/query-options";
import {
  collectionLevel,
  gameState,
  positivePage,
  rangeLabel,
  readLocation,
  storageLabel,
} from "./navigation";
import { Counts, GameDetail, Pagination } from "./collection-panels";

export interface CollectionExecutionState {
  range: CollectionDateRange;
  target: "uncollected" | "source_failure";
  mode: "all_matching" | "explicit";
  included: string[];
  excluded: string[];
  unknownDate: boolean;
}
export function initialCollectionExecution(range: CollectionDateRange): CollectionExecutionState {
  return {
    range,
    target: "uncollected",
    mode: "all_matching",
    included: [],
    excluded: [],
    unknownDate: false,
  };
}

export function CollectionStatus({
  discovery,
  params,
  update,
  onJob,
  execution,
  setExecution,
}: {
  discovery: CollectionDiscovery;
  params: URLSearchParams;
  update: (values: Record<string, string | null>, replace?: boolean) => void;
  onJob: (id: string) => void;
  execution: CollectionExecutionState;
  setExecution: React.Dispatch<React.SetStateAction<CollectionExecutionState>>;
}): React.JSX.Element {
  const client = useQueryClient();
  const range = discovery.range,
    location = readLocation(params, range);
  const search = useDeferredValue(params.get("q") ?? "");
  const state = gameState(params.get("state"));
  const unknown = params.get("unknown") === "true";
  const showGames =
    search.trim() !== "" || state !== undefined || unknown || collectionLevel(location) === "games";
  const listRange = search.trim() !== "" ? range : location;
  const page = positivePage(params.get("page"));
  const overview = useQuery(
    overviewOptions(discovery.discoveryId, {
      ...location,
      groupBy: collectionLevel(location) === "month" ? "month" : "day",
    }),
  );
  const games = useQuery({
    ...collectionGamesOptions(discovery.discoveryId, {
      ...listRange,
      search,
      ...(state === undefined ? {} : { state }),
      unknownDate: unknown,
      page,
      limit: 50,
    }),
    enabled: showGames,
  });
  const selectedGame =
    games.data?.games.find((game) => game.gameId === params.get("selected")) ?? null;
  const {
    range: executionRange,
    target,
    mode,
    included,
    excluded,
    unknownDate: executionUnknown,
  } = execution;
  const setExecutionRange = (value: CollectionDateRange): void =>
    setExecution((previous) => ({ ...previous, range: value }));
  const setTarget = (value: CollectionExecutionState["target"]): void =>
    setExecution((previous) => ({ ...previous, target: value }));
  const setMode = (value: CollectionExecutionState["mode"]): void =>
    setExecution((previous) => ({ ...previous, mode: value }));
  const setExecutionUnknown = (value: boolean): void =>
    setExecution((previous) => ({ ...previous, unknownDate: value }));
  const setIncluded = (value: React.SetStateAction<string[]>): void =>
    setExecution((previous) => ({
      ...previous,
      included: typeof value === "function" ? value(previous.included) : value,
    }));
  const setExcluded = (value: React.SetStateAction<string[]>): void =>
    setExecution((previous) => ({
      ...previous,
      excluded: typeof value === "function" ? value(previous.excluded) : value,
    }));
  const eligible = useQuery(
    collectionGamesOptions(discovery.discoveryId, {
      ...executionRange,
      state: target,
      unknownDate: executionUnknown,
      page: 1,
      limit: 1,
    }),
  );
  const total =
    target === "uncollected" && !discovery.complete ? null : (eligible.data?.total ?? null);
  const count =
    total === null
      ? null
      : mode === "all_matching"
        ? Math.max(0, total - excluded.length)
        : included.length;
  const resetSelection = (): void => {
    setMode("all_matching");
    setIncluded([]);
    setExcluded([]);
  };
  const run = useMutation({
    mutationFn: async () => {
      const request: CollectionSelectionCreate = {
        discoveryId: discovery.discoveryId,
        range: executionRange,
        target,
        mode,
        gameIds: included,
        excludedGameIds: excluded,
        unknownDate: executionUnknown,
      };
      const selection = await createCollectionSelection(request);
      if (selection.count === 0)
        throw new Error("현재 조건에 맞는 수집 대상이 없습니다. 현황을 새로 확인해 주세요.");
      return createCollectionJob({
        scope: { kind: "selection", selectionId: selection.selectionId },
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: async (job) => {
      onJob(job.jobId);
      resetSelection();
      await Promise.all([
        client.invalidateQueries({ queryKey: collectionOperationKey }),
        client.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: collectionOperationKey });
    },
  });
  function isEligible(game: CollectionGameSummary): boolean {
    return (
      game.state === target &&
      (executionUnknown
        ? game.gameDate === null
        : game.gameDate !== null &&
          game.gameDate >= executionRange.startDate &&
          game.gameDate <= executionRange.endDate)
    );
  }
  function toggle(gameId: string): void {
    if (mode === "all_matching")
      setExcluded((ids) =>
        ids.includes(gameId) ? ids.filter((id) => id !== gameId) : [...ids, gameId],
      );
    else
      setIncluded((ids) =>
        ids.includes(gameId) ? ids.filter((id) => id !== gameId) : [...ids, gameId],
      );
  }
  const error = overview.error ?? games.error ?? eligible.error ?? run.error;
  const navigatePeriod = (next: CollectionDateRange): void =>
    update({
      from: next.startDate,
      to: next.endDate,
      page: null,
      selected: null,
      state: null,
      q: null,
      unknown: null,
    });
  return (
    <>
      <section className="panel collection-execution" aria-label="수집 실행 대상">
        <div>
          <span className="collection-eyebrow">실행 대상</span>
          <strong>{executionUnknown ? "날짜 미확인 원천 실패" : rangeLabel(executionRange)}</strong>
          <p>보정 중인 작업본은 유지합니다. 탐색·표시 필터는 실행 대상을 바꾸지 않습니다.</p>
        </div>
        <label>
          수집 조건
          <select
            aria-label="수집 조건"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value === "source_failure" ? "source_failure" : "uncollected");
              setExecutionUnknown(false);
              resetSelection();
            }}
          >
            <option value="uncollected">미수집만</option>
            <option value="source_failure">원천 실패 재시도</option>
          </select>
        </label>
        <div className="collection-selection">
          <strong>{count?.toLocaleString("ko-KR") ?? "—"}경기 선택</strong>
          <span>
            {mode === "all_matching"
              ? `조건에 맞는 전체${excluded.length > 0 ? ` · ${excluded.length}경기 제외` : ""}`
              : "개별 선택"}
          </span>
        </div>
        <button
          className="primary-button"
          disabled={count === null || count === 0 || eligible.isFetching || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending
            ? "대상 확정 중"
            : `${target === "uncollected" ? "미수집" : "원천 실패"} ${count?.toLocaleString("ko-KR") ?? "—"}경기 ${target === "uncollected" ? "수집" : "재시도"}`}
        </button>
        <div className="collection-selection-actions">
          <button className="collection-text-button" onClick={resetSelection}>
            조건에 맞는 경기 전체 선택
          </button>
          <button
            className="collection-text-button"
            onClick={() => {
              setMode("explicit");
              setIncluded([]);
              setExcluded([]);
            }}
          >
            선택 해제 · 개별 선택
          </button>
          {executionRange.startDate !== range.startDate ||
          executionRange.endDate !== range.endDate ||
          executionUnknown ? (
            <button
              className="collection-text-button"
              onClick={() => {
                setExecutionRange(range);
                setExecutionUnknown(false);
                resetSelection();
              }}
            >
              조회 기간 전체를 대상으로 설정
            </button>
          ) : null}
        </div>
      </section>
      {error !== null ? (
        <p role="alert" className="inline-error">
          {error.message}
        </p>
      ) : null}
      <div
        className={`collection-explorer${selectedGame !== null && showGames ? " with-detail" : ""}`}
      >
        <section className="panel collection-periods" aria-label="기간별 수집 현황">
          <div className="collection-toolbar">
            <nav className="collection-breadcrumb" aria-label="수집 기간 탐색">
              <button onClick={() => navigatePeriod(range)}>{rangeLabel(range)}</button>
              {location.startDate !== range.startDate || location.endDate !== range.endDate ? (
                <>
                  <span aria-hidden="true">/</span>
                  {collectionLevel(location) === "games" && collectionLevel(range) === "month" ? (
                    <>
                      <button
                        onClick={() => {
                          const startDate = `${location.startDate.slice(0, 7)}-01`,
                            date = new Date(`${startDate}T00:00:00Z`);
                          const endDate = new Date(
                            Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
                          )
                            .toISOString()
                            .slice(0, 10);
                          navigatePeriod({
                            startDate: startDate < range.startDate ? range.startDate : startDate,
                            endDate: endDate > range.endDate ? range.endDate : endDate,
                          });
                        }}
                      >
                        {location.startDate.slice(0, 7)}
                      </button>
                      <span aria-hidden="true">/</span>
                    </>
                  ) : null}
                  <strong>{rangeLabel(location)}</strong>
                </>
              ) : null}
            </nav>
            <button
              className="secondary-button"
              onClick={() => {
                setExecutionRange(location);
                setExecutionUnknown(unknown);
                if (unknown) setTarget("source_failure");
                resetSelection();
              }}
            >
              {unknown
                ? "날짜 미확인 경기를 대상으로 설정"
                : collectionLevel(location) === "games"
                  ? "현재 날짜만 대상으로 설정"
                  : "현재 기간만 대상으로 설정"}
            </button>
          </div>
          <Counts counts={overview.data?.counts} />
          {!discovery.complete ? (
            <p className="collection-notice">
              일정을 완전히 확인하지 못해 미수집 수는 아직 알 수 없습니다. 확인된 자료만 표시합니다.
            </p>
          ) : null}
          <div className="collection-toolbar collection-filters">
            <label className="collection-search">
              선택 범위 전체 검색
              <input
                type="search"
                placeholder="팀·날짜·경기 ID"
                value={params.get("q") ?? ""}
                onChange={(event) =>
                  update({ q: event.target.value, selected: null, page: null }, true)
                }
              />
            </label>
            <label>
              표시 상태
              <select
                aria-label="표시 상태"
                value={state ?? "all"}
                onChange={(event) =>
                  update({
                    state: event.target.value === "all" ? null : event.target.value,
                    page: null,
                    selected: null,
                  })
                }
              >
                <option value="all">전체</option>
                {Object.entries(storageLabel).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {(overview.data?.unknownDateCount ?? 0) > 0 ? (
              <button
                className="collection-text-button"
                onClick={() =>
                  update({ unknown: unknown ? null : "true", page: null, selected: null })
                }
              >
                {unknown
                  ? "날짜가 확인된 경기 보기"
                  : `날짜 미확인 원천 실패 ${overview.data?.unknownDateCount}경기`}
              </button>
            ) : null}
          </div>
          {showGames ? (
            <>
              <div className="collection-list-heading">
                <h2>
                  {unknown
                    ? "날짜 미확인 경기"
                    : search.trim() !== ""
                      ? "범위 전체 검색 결과"
                      : "경기 목록"}
                </h2>
                <span>개별 선택은 실행 대상 조건 안에서만 가능합니다.</span>
              </div>
              <div className="collection-table-scroll">
                <table className="collection-table">
                  <thead>
                    <tr>
                      <th>선택</th>
                      <th>경기</th>
                      <th>날짜</th>
                      <th>저장 상태</th>
                      <th>검증 결과</th>
                      <th>DB 저장</th>
                    </tr>
                  </thead>
                  <tbody>
                    {games.data?.games.map((game) => (
                      <tr
                        key={game.gameId}
                        className={selectedGame?.gameId === game.gameId ? "selected" : ""}
                      >
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${game.label} 수집 선택`}
                            disabled={!isEligible(game)}
                            checked={
                              isEligible(game) &&
                              (mode === "all_matching"
                                ? !excluded.includes(game.gameId)
                                : included.includes(game.gameId))
                            }
                            onChange={() => toggle(game.gameId)}
                          />
                        </td>
                        <th>
                          <button
                            className="collection-row-link"
                            onClick={() => update({ selected: game.gameId })}
                          >
                            {game.label}
                          </button>
                        </th>
                        <td>{game.gameDate ?? "미확인"}</td>
                        <td>
                          <span className={`authority-mark ${game.state}`}>
                            {storageLabel[game.state]}
                          </span>
                        </td>
                        <td>
                          {game.state === "uncollected"
                            ? "—"
                            : `차단 ${game.blockingFindings} · 경고 ${game.warningFindings}`}
                        </td>
                        <td>{game.databaseRevision === null ? "—" : "저장됨"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {games.isFetching ? (
                <p role="status" className="collection-notice">
                  경기 목록을 확인하고 있습니다.
                </p>
              ) : null}
              {games.data?.total === 0 ? (
                <div className="collection-empty">조건에 맞는 경기가 없습니다.</div>
              ) : null}
              <Pagination
                page={page}
                total={games.data?.total ?? 0}
                onChange={(next) => update({ page: String(next), selected: null })}
              />
            </>
          ) : (
            <>
              <div className="collection-list-heading">
                <h2>{collectionLevel(location) === "month" ? "월별 현황" : "날짜별 현황"}</h2>
                <span>기간을 선택하면 하위 현황을 볼 수 있습니다.</span>
              </div>
              <div className="collection-table-scroll">
                <table className="collection-table collection-period-table">
                  <thead>
                    <tr>
                      <th>기간</th>
                      <th>전체</th>
                      <th>미수집</th>
                      <th>적재 가능</th>
                      <th>검토 필요</th>
                      <th>원천 실패</th>
                      <th>DB 저장</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.data?.groups.map((group) => (
                      <tr key={group.key}>
                        <th>
                          <button
                            className="collection-row-link"
                            onClick={() => navigatePeriod(group)}
                          >
                            {group.key}
                            <span aria-hidden="true"> →</span>
                          </button>
                        </th>
                        <td>{group.counts.total}</td>
                        <td className="collection-missing">{group.counts.uncollected ?? "—"}</td>
                        <td>{group.counts.staging}</td>
                        <td>{group.counts.quarantine}</td>
                        <td>{group.counts.source_failure}</td>
                        <td>{group.counts.database}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
        {selectedGame !== null && showGames ? (
          <GameDetail
            game={selectedGame}
            onClose={() => update({ selected: null })}
            onRetry={() => {
              setTarget("source_failure");
              setExecutionRange(range);
              setExecutionUnknown(selectedGame.gameDate === null);
              setMode("explicit");
              setIncluded([selectedGame.gameId]);
              setExcluded([]);
            }}
          />
        ) : null}
      </div>
    </>
  );
}
