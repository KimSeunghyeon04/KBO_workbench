import { randomUUID } from "node:crypto";

import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
  type NaverGameCollector,
  type PlaywrightScheduleExplorer,
  hashRawGameBundle,
  sourceSeasonFromNaverBundle,
} from "@kbo/collection";
import {
  canonicalStringify,
  type CollectionJob,
  type CollectionJobCreateRequest,
  type JobEvent,
} from "@kbo/contracts";
import { type CurrentRevisionBase, type StagingWorkspace } from "@kbo/persistence";

import { projectNaverSourceBundle, storedSourceFinding } from "../source-projection.js";

interface InternalJob {
  readonly request: CollectionJobCreateRequest;
  readonly controller: AbortController;
  readonly events: JobEvent[];
  readonly listeners: Set<(event: JobEvent) => void>;
  snapshot: CollectionJob;
  sequence: number;
  execution: Promise<void> | null;
}

export class JobNotFoundError extends Error {}
export class IdempotencyConflictError extends Error {}
export class InvalidCollectionRequestError extends Error {}

export class CollectionJobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly jobId: string }
  >();
  private running = 0;
  private closed = false;

  public constructor(
    private readonly explorer: Pick<PlaywrightScheduleExplorer, "discoverRange">,
    private readonly collector: Pick<NaverGameCollector, "collect">,
    private readonly workspace: StagingWorkspace,
    private readonly maxConcurrentJobs = 1,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly findCurrentRevisionBase: (
      gameId: string,
    ) => Promise<CurrentRevisionBase | null> = async () => null,
  ) {}

  public create(request: CollectionJobCreateRequest): CollectionJob {
    if (this.closed) throw new Error("종료 중에는 job을 만들 수 없습니다.");
    validateScope(request.scope);
    const fingerprint = canonicalStringify(request.scope);
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("같은 idempotency key에 다른 수집 범위가 지정됐습니다.");
      }
      return this.get(existing.jobId);
    }
    const jobId = this.newId();
    const snapshot: CollectionJob = {
      jobId,
      kind: "collection",
      scope: structuredClone(request.scope),
      status: "queued",
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      completedItems: 0,
      skippedItems: 0,
      totalItems: request.scope.kind === "game_ids" ? request.scope.gameIds.length : null,
      currentGameId: null,
      summary: { ready: 0, quarantined: 0, sourceFailures: 0 },
      error: null,
      errorCategory: null,
    };
    const internal: InternalJob = {
      request,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
      snapshot,
      sequence: 0,
      execution: null,
    };
    this.jobs.set(jobId, internal);
    this.idempotency.set(request.idempotencyKey, { fingerprint, jobId });
    this.emit(internal, "queued", "수집 작업이 대기열에 추가됐습니다.", null, "none");
    queueMicrotask(() => this.pump());
    return cloneJob(snapshot);
  }

  public get(jobId: string): CollectionJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    return cloneJob(job.snapshot);
  }

  public list(): readonly CollectionJob[] {
    return [...this.jobs.values()]
      .map((job) => cloneJob(job.snapshot))
      .sort((left, right) => compareText(right.createdAt, left.createdAt));
  }

  public restoreInterrupted(jobs: readonly CollectionJob[]): void {
    if (this.jobs.size > 0) throw new Error("작업 복구는 새 manager에서만 수행할 수 있습니다.");
    for (const snapshot of jobs) {
      const internal: InternalJob = {
        request: {
          scope: structuredClone(snapshot.scope),
          idempotencyKey: `recovered-${snapshot.jobId}`,
        },
        controller: new AbortController(),
        events: [],
        listeners: new Set(),
        snapshot: cloneJob(snapshot),
        sequence: 0,
        execution: Promise.resolve(),
      };
      this.jobs.set(snapshot.jobId, internal);
      this.emit(
        internal,
        "failed",
        snapshot.error ?? "API 재시작으로 작업이 중단됐습니다.",
        null,
        "none",
      );
    }
  }

  public cancel(jobId: string): CollectionJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    if (isTerminal(job.snapshot.status)) return cloneJob(job.snapshot);
    if (job.snapshot.status === "queued") {
      job.snapshot = {
        ...job.snapshot,
        status: "cancelled",
        finishedAt: this.now().toISOString(),
      };
      this.emit(job, "cancelled", "대기 중인 수집 작업을 취소했습니다.", null, "none");
    } else {
      job.snapshot = { ...job.snapshot, status: "cancelling" };
      this.emit(
        job,
        "cancelling",
        "현재 경기 수집을 중단하고 있습니다.",
        job.snapshot.currentGameId,
        "none",
      );
      job.controller.abort();
    }
    return cloneJob(job.snapshot);
  }

  public eventsAfter(jobId: string, lastEventId: string | undefined): readonly JobEvent[] {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    const sequence = parseLastSequence(jobId, lastEventId);
    return job.events.filter((event) => event.sequence > sequence);
  }

  public subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  public async waitForTerminal(jobId: string): Promise<CollectionJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    while (job.execution === null && !isTerminal(job.snapshot.status)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await job.execution;
    return cloneJob(job.snapshot);
  }

  public async close(): Promise<void> {
    this.closed = true;
    const executions: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.snapshot.status)) job.controller.abort();
      if (job.execution !== null) executions.push(job.execution);
    }
    await Promise.allSettled(executions);
  }

  private pump(): void {
    if (this.closed) return;
    while (this.running < this.maxConcurrentJobs) {
      const next = [...this.jobs.values()].find((job) => job.snapshot.status === "queued");
      if (next === undefined) return;
      this.running += 1;
      next.execution = this.run(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async run(job: InternalJob): Promise<void> {
    job.snapshot = {
      ...job.snapshot,
      status: "running",
      startedAt: this.now().toISOString(),
    };
    let journalCreated = false;
    try {
      await this.workspace.saveCollectionJobJournal(job.snapshot);
      journalCreated = true;
      this.emit(job, "started", "수집 작업을 시작했습니다.", null, "none");
      const gameIds =
        job.request.scope.kind === "game_ids"
          ? job.request.scope.gameIds
          : (
              await this.explorer.discoverRange(
                job.request.scope.startDate,
                job.request.scope.endDate,
                job.controller.signal,
              )
            ).map((entry) => entry.gameId);
      const stagingGameIds = new Set(
        (await this.workspace.catalog()).games
          .filter((game) => game.authority === "staging")
          .map((game) => game.gameId),
      );
      const gameIdsToCollect = gameIds.filter((gameId) => !stagingGameIds.has(gameId));
      const skippedItems = gameIds.length - gameIdsToCollect.length;
      job.snapshot = {
        ...job.snapshot,
        completedItems: job.snapshot.completedItems + skippedItems,
        skippedItems: job.snapshot.skippedItems + skippedItems,
        totalItems: gameIds.length,
      };
      this.emit(job, "progress", `${String(gameIds.length)}경기를 확인했습니다.`, null, "none");
      if (skippedItems > 0) {
        await this.workspace.saveCollectionJobJournal(job.snapshot);
        this.emit(
          job,
          "progress",
          `이미 staging인 ${String(skippedItems)}경기의 재수집을 건너뛰었습니다.`,
          null,
          "none",
        );
      }
      for (const gameId of gameIdsToCollect) {
        if (job.controller.signal.aborted) throw new CollectionCancelledError();
        job.snapshot = { ...job.snapshot, currentGameId: gameId };
        this.emit(job, "progress", "경기 자료를 수집하고 있습니다.", gameId, "none");
        const disposition = await this.collectOne(job, gameId);
        job.snapshot = {
          ...job.snapshot,
          completedItems: job.snapshot.completedItems + 1,
          currentGameId: null,
          summary: incrementSummary(job.snapshot.summary, disposition),
        };
        await this.workspace.saveCollectionJobJournal(job.snapshot);
        this.emit(job, "game_completed", "경기 처리를 완료했습니다.", gameId, disposition);
      }
      await this.workspace.removeCollectionJobJournal(job.snapshot.jobId);
      journalCreated = false;
      job.snapshot = {
        ...job.snapshot,
        status: "succeeded",
        currentGameId: null,
        finishedAt: this.now().toISOString(),
      };
      this.emit(job, "succeeded", "수집 작업을 완료했습니다.", null, "none");
    } catch (error: unknown) {
      if (error instanceof CollectionCancelledError || job.controller.signal.aborted) {
        job.snapshot = {
          ...job.snapshot,
          status: "cancelled",
          currentGameId: null,
          finishedAt: this.now().toISOString(),
        };
        this.emit(job, "cancelled", "수집 작업이 취소됐습니다.", null, "none");
      } else {
        const message = error instanceof Error ? error.message : "알 수 없는 수집 오류";
        job.snapshot = {
          ...job.snapshot,
          status: "failed",
          currentGameId: null,
          finishedAt: this.now().toISOString(),
          error: message,
          errorCategory: collectionErrorCategory(error),
        };
        this.emit(job, "failed", message, null, "none");
      }
    } finally {
      if (journalCreated) {
        await this.workspace.removeCollectionJobJournal(job.snapshot.jobId).catch(() => undefined);
      }
    }
  }

  private async collectOne(
    job: InternalJob,
    gameId: string,
  ): Promise<"none" | "ready" | "quarantined" | "source_failure"> {
    const collected = await this.collector.collect(gameId, job.controller.signal);
    if (collected.disposition === "source_failure" || collected.bundle === null) {
      await this.workspace.saveSourceFailure(gameId, collected.findings.map(storedSourceFinding));
      return "source_failure";
    }
    const sourceBundleHash = hashRawGameBundle(collected.bundle);
    const sourceSeason = sourceSeasonFromNaverBundle(collected.bundle);
    await this.workspace.saveSourceBundle({
      gameId,
      season: sourceSeason,
      collectedAt: collected.bundle.collectedAt,
      sourceBundleHash,
      payloads: collected.bundle.payloads,
      missingEndpoints: collected.bundle.missingEndpoints,
    });
    try {
      const currentBase = await this.findCurrentRevisionBase(gameId);
      if (currentBase?.sourceBundleHash === sourceBundleHash) return "none";
      const { document, findings } = projectNaverSourceBundle(
        collected.bundle,
        currentBase,
        collected.findings,
      );
      if (findings.some((finding) => finding.severity === "blocking")) {
        await this.workspace.saveQuarantine(document, findings);
        return "quarantined";
      }
      await this.workspace.saveReady(document, findings);
      return "ready";
    } catch (error: unknown) {
      const message =
        error instanceof NaverSourceFormatError || error instanceof Error
          ? error.message
          : "Naver mapping 중 알 수 없는 오류가 발생했습니다.";
      await this.workspace.saveSourceFailure(
        gameId,
        [
          {
            producer: "collection",
            lifecycle: "persistent",
            code: "source.mapping_failed",
            category: "source",
            severity: "blocking",
            message,
          },
        ],
        sourceSeason,
      );
      return "source_failure";
    }
  }

  private emit(
    job: InternalJob,
    type: JobEvent["type"],
    message: string,
    gameId: string | null,
    disposition: JobEvent["payload"]["disposition"],
  ): void {
    job.sequence += 1;
    const event: JobEvent = {
      eventId: `${job.snapshot.jobId}:${String(job.sequence)}`,
      jobId: job.snapshot.jobId,
      sequence: job.sequence,
      occurredAt: this.now().toISOString(),
      type,
      payload: {
        message,
        gameId,
        disposition,
        completedItems: job.snapshot.completedItems,
        totalItems: job.snapshot.totalItems,
      },
    };
    job.events.push(event);
    if (job.events.length > 2_000) job.events.shift();
    for (const listener of job.listeners) listener(event);
  }
}

function incrementSummary(
  summary: CollectionJob["summary"],
  disposition: "none" | "ready" | "quarantined" | "source_failure",
): CollectionJob["summary"] {
  return {
    ready: summary.ready + (disposition === "ready" ? 1 : 0),
    quarantined: summary.quarantined + (disposition === "quarantined" ? 1 : 0),
    sourceFailures: summary.sourceFailures + (disposition === "source_failure" ? 1 : 0),
  };
}

function parseLastSequence(jobId: string, eventId: string | undefined): number {
  if (eventId === undefined || eventId === "") return 0;
  const prefix = `${jobId}:`;
  if (!eventId.startsWith(prefix)) return 0;
  const value = Number(eventId.slice(prefix.length));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function isTerminal(status: CollectionJob["status"]): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}

function collectionErrorCategory(error: unknown): "source" | "persistence" {
  if (
    error instanceof NaverTransportError ||
    error instanceof NaverHttpError ||
    error instanceof NaverEndpointMissingError ||
    error instanceof NaverSourceFormatError
  ) {
    return "source";
  }
  return isNodeError(error) ? "persistence" : "source";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cloneJob(job: CollectionJob): CollectionJob {
  return { ...job, scope: structuredClone(job.scope), summary: { ...job.summary } };
}

function validateScope(scope: CollectionJobCreateRequest["scope"]): void {
  if (scope.kind !== "date_range") return;
  const start = parseCalendarDate(scope.startDate);
  const end = parseCalendarDate(scope.endDate);
  if (start === null || end === null) {
    throw new InvalidCollectionRequestError("유효한 날짜 범위를 입력해야 합니다.");
  }
  if (start > end) {
    throw new InvalidCollectionRequestError("시작일은 종료일보다 늦을 수 없습니다.");
  }
}

function parseCalendarDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? timestamp
    : null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
