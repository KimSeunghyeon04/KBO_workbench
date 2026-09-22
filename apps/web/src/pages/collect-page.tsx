import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { CollectionDateRange } from "@kbo/contracts";
import {
  activeCollectionOptions,
  cancelDiscovery,
  collectionOperationKey,
  createDiscovery,
  discoveryListOptions,
  discoveryOptions,
  listDiscoveries,
} from "../api/collection-operations-client";
import { cancelCollectionJob } from "../api/collection-client";
import {
  collectionNavigationKey,
  dateTimeLabel,
  positivePage,
  readRange,
  restoredParams,
} from "../collection/navigation";
import { ActiveJob, CollectionHistory, Counts } from "../collection/collection-panels";
import { CollectionStatus, initialCollectionExecution } from "../collection/collection-status";
import { decodeCollectionJobEvent } from "../collection/job-event-refresh";
import "../styles/collection-periods.css";

export function CollectPage(): React.JSX.Element {
  const client = useQueryClient();
  const [urlParams, setSearchParams] = useSearchParams();
  const initial = useMemo(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(collectionNavigationKey);
    } catch {
      /* Browser storage may be unavailable. URL navigation remains usable. */
    }
    return restoredParams(urlParams, saved);
  }, []);
  const params = urlParams.has("start") && urlParams.has("end") ? urlParams : initial;
  const range = readRange(params);
  const [execution, setExecution] = useState(() => initialCollectionExecution(range));
  useEffect(() => {
    setExecution(
      initialCollectionExecution({ startDate: range.startDate, endDate: range.endDate }),
    );
  }, [range.startDate, range.endDate]);
  const [formRange, setFormRange] = useState(range);
  const [mode, setMode] = useState<"date_range" | "season">("date_range");
  const [season, setSeason] = useState(range.startDate.slice(0, 4));
  const update = useCallback(
    (values: Record<string, string | null>, replace = false) => {
      setSearchParams(
        (previous) => {
          const next = previous.has("start")
            ? new URLSearchParams(previous)
            : new URLSearchParams(initial);
          for (const [key, value] of Object.entries(values)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      );
    },
    [initial, setSearchParams],
  );
  useEffect(() => {
    if (!urlParams.has("start") || !urlParams.has("end"))
      setSearchParams(initial, { replace: true });
  }, [initial, urlParams, setSearchParams]);
  useEffect(() => {
    try {
      localStorage.setItem(collectionNavigationKey, params.toString());
    } catch {
      /* URL state still works without local storage. */
    }
  }, [params]);
  useEffect(() => {
    setFormRange({ startDate: range.startDate, endDate: range.endDate });
    setSeason(range.startDate.slice(0, 4));
  }, [range.startDate, range.endDate]);
  const saved = useQuery(discoveryListOptions(range));
  const discoveryId = params.get("discovery") ?? saved.data?.discoveries[0]?.discoveryId ?? "";
  const discovery = useQuery({
    ...discoveryOptions(discoveryId),
    refetchInterval: (query) =>
      query.state.data?.status === "queued" || query.state.data?.status === "running"
        ? 1_000
        : false,
  });
  const currentDiscovery =
    discovery.data !== undefined &&
    discovery.data.range.startDate === range.startDate &&
    discovery.data.range.endDate === range.endDate
      ? discovery.data
      : undefined;
  const discovering =
    currentDiscovery?.status === "running" || currentDiscovery?.status === "queued";
  useEffect(() => {
    if (
      currentDiscovery !== undefined &&
      currentDiscovery.status !== "running" &&
      currentDiscovery.status !== "queued"
    ) {
      void client.invalidateQueries({
        queryKey: [...collectionOperationKey, "overview", currentDiscovery.discoveryId],
      });
      void client.invalidateQueries({
        queryKey: [...collectionOperationKey, "games", currentDiscovery.discoveryId],
      });
    }
  }, [client, currentDiscovery?.discoveryId, currentDiscovery?.status]);
  const active = useQuery({ ...activeCollectionOptions(), refetchInterval: 2_000 });
  const trackedJobs = useRef(new Set<string>());
  const [startedJob, setStartedJob] = useState<string | null>(null);
  const activeIds =
    active.data?.jobs
      .map((job) => job.jobId)
      .sort()
      .join(",") ?? "";
  useEffect(() => {
    for (const id of activeIds.split(",").filter(Boolean)) trackedJobs.current.add(id);
    if (active.data === undefined) return;
    for (const id of trackedJobs.current)
      if (!active.data.jobs.some((job) => job.jobId === id)) {
        trackedJobs.current.delete(id);
        void client.invalidateQueries({ queryKey: collectionOperationKey });
        if (id === startedJob) {
          update({ tab: "history", job: id, results: null, resultPage: null });
          setStartedJob(null);
        }
      }
  }, [active.data, activeIds, client, startedJob, update]);
  useEffect(() => {
    const streams = activeIds
      .split(",")
      .filter(Boolean)
      .map((id) => {
        const stream = new EventSource(`/api/v2/collection-jobs/${encodeURIComponent(id)}/events`);
        stream.onopen = () => {
          void client.invalidateQueries({ queryKey: collectionOperationKey });
        };
        stream.onmessage = (message) => {
          try {
            const event = decodeCollectionJobEvent(message.data);
            if (event.type !== "progress")
              void client.invalidateQueries({ queryKey: collectionOperationKey });
          } catch {
            /* Snapshot polling recovers from malformed or truncated events. */
          }
        };
        return stream;
      });
    return () => streams.forEach((stream) => stream.close());
  }, [activeIds, client]);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: collectionOperationKey });
  }, [client]);
  const discover = useMutation({
    mutationFn: async ({ next, force }: { next: CollectionDateRange; force: boolean }) => {
      const cached = force ? undefined : (await listDiscoveries(next)).discoveries[0];
      return cached ?? createDiscovery({ ...next, idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: async (result) => {
      update({
        start: result.range.startDate,
        end: result.range.endDate,
        from: null,
        to: null,
        discovery: result.discoveryId,
        q: null,
        state: null,
        selected: null,
        page: null,
        unknown: null,
        tab: null,
      });
      await refresh();
    },
  });
  const cancel = useMutation({ mutationFn: cancelCollectionJob, onSuccess: refresh });
  const stopDiscovery = useMutation({ mutationFn: cancelDiscovery, onSuccess: refresh });
  const error =
    discover.error ??
    saved.error ??
    discovery.error ??
    active.error ??
    cancel.error ??
    stopDiscovery.error;
  function onJob(id: string): void {
    setStartedJob(id);
    trackedJobs.current.add(id);
    update({ tab: "history", job: id, results: null, resultPage: null });
  }
  return (
    <div className="page-stack collect-page collection-period-page">
      <header className="page-header">
        <div>
          <h1>경기 수집</h1>
          <p>기간별 현황을 확인하고 필요한 경기만 수집합니다.</p>
        </div>
      </header>
      <nav className="collection-tabs" aria-label="수집 화면">
        <button
          aria-current={params.get("tab") !== "history" ? "page" : undefined}
          onClick={() => update({ tab: null })}
        >
          수집 현황
        </button>
        <button
          aria-current={params.get("tab") === "history" ? "page" : undefined}
          onClick={() => update({ tab: "history" })}
        >
          수집 기록
        </button>
      </nav>
      {active.data?.jobs.map((job) => (
        <ActiveJob
          key={job.jobId}
          job={job}
          onCancel={() => cancel.mutate(job.jobId)}
          onOpen={() => update({ tab: "history", job: job.jobId, resultPage: null })}
        />
      ))}
      {error !== null ? (
        <p role="alert" className="inline-error">
          {error.message}
        </p>
      ) : null}
      {params.get("tab") === "history" ? (
        <CollectionHistory
          page={positivePage(params.get("historyPage"))}
          jobId={params.get("job") ?? ""}
          resultPage={positivePage(params.get("resultPage"))}
          problemsOnly={params.get("results") !== "all"}
          update={update}
        />
      ) : (
        <>
          <section className="panel collection-range-panel">
            <form
              className="collection-range-form"
              onSubmit={(event) => {
                event.preventDefault();
                discover.mutate({
                  next:
                    mode === "season"
                      ? { startDate: `${season}-01-01`, endDate: `${season}-12-31` }
                      : formRange,
                  force: false,
                });
              }}
            >
              <label>
                범위
                <select
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value === "season" ? "season" : "date_range")
                  }
                >
                  <option value="date_range">날짜 범위</option>
                  <option value="season">시즌 전체</option>
                </select>
              </label>
              {mode === "date_range" ? (
                <>
                  <label>
                    시작일
                    <input
                      type="date"
                      value={formRange.startDate}
                      required
                      max={formRange.endDate}
                      onChange={(event) =>
                        setFormRange({ ...formRange, startDate: event.target.value })
                      }
                    />
                  </label>
                  <span className="collection-range-divider" aria-hidden="true">
                    ~
                  </span>
                  <label>
                    종료일
                    <input
                      type="date"
                      value={formRange.endDate}
                      required
                      min={formRange.startDate}
                      onChange={(event) =>
                        setFormRange({ ...formRange, endDate: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <label>
                  시즌
                  <input
                    type="number"
                    min="1982"
                    max="9999"
                    value={season}
                    required
                    onChange={(event) => setSeason(event.target.value)}
                  />
                </label>
              )}
              <button className="primary-button" disabled={discover.isPending} type="submit">
                {discover.isPending ? "확인 중" : "경기 확인"}
              </button>
            </form>
            <div className="collection-cache-status" role="status">
              {currentDiscovery === undefined ? (
                <span>아직 확인한 일정이 없습니다. 기간을 지정한 뒤 경기 확인을 눌러 주세요.</span>
              ) : (
                <>
                  <span>
                    {discovering
                      ? `일정 확인 중 · ${currentDiscovery.pageCount}페이지`
                      : `${currentDiscovery.complete ? "저장된 일정" : "미완료 일정"} · ${dateTimeLabel(currentDiscovery.createdAt)} 확인`}
                  </span>
                  {discovering ? (
                    <button
                      className="collection-text-button"
                      disabled={stopDiscovery.isPending}
                      onClick={() => stopDiscovery.mutate(currentDiscovery.discoveryId)}
                    >
                      일정 확인 취소
                    </button>
                  ) : (
                    <button
                      className="collection-text-button"
                      disabled={discover.isPending}
                      onClick={() => discover.mutate({ next: range, force: true })}
                    >
                      일정 새로 확인
                    </button>
                  )}
                </>
              )}
            </div>
            {currentDiscovery?.error !== null && currentDiscovery?.error !== undefined ? (
              <p className="inline-error">{currentDiscovery.error}</p>
            ) : null}
          </section>
          {currentDiscovery === undefined ? (
            <section className="panel collection-periods">
              <Counts counts={undefined} />
              <div className="collection-empty">
                하루는 경기 목록, 한 달은 날짜별 현황, 여러 달은 월별 현황으로 확인합니다.
              </div>
            </section>
          ) : (
            <CollectionStatus
              key={currentDiscovery.discoveryId}
              discovery={currentDiscovery}
              params={params}
              update={update}
              onJob={onJob}
              execution={execution}
              setExecution={setExecution}
            />
          )}
        </>
      )}
    </div>
  );
}
