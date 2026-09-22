import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";

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
  CollectionJobCreateRequestSchema,
  type CollectionDateRange,
  type CollectionSelectionEntry,
  type CollectionItemResult,
  type CollectionJob,
  type CollectionJobCreateRequest,
  type JobEvent,
} from "@kbo/contracts";
import {
  StaleStagingDocumentError,
  type CurrentRevisionBase,
  type StagingWorkspace,
} from "@kbo/persistence";

import { projectNaverSourceBundle, storedSourceFinding } from "../source-projection.js";
import type { SourceProjection } from "../source-projection.js";

interface InternalJob {
  readonly request: CollectionJobCreateRequest;
  readonly controller: AbortController;
  readonly events: JobEvent[];
  readonly listeners: Set<(event: JobEvent) => void>;
  snapshot: CollectionJob;
  sequence: number;
  execution: Promise<void> | null;
  persistence: Promise<void>;
  range: CollectionDateRange | null;
  durable: boolean;
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
  private creation: Promise<unknown> = Promise.resolve();
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
    private readonly projectSource: (
      bundle: Parameters<typeof projectNaverSourceBundle>[0],
      base: CurrentRevisionBase | null,
      findings: Parameters<typeof projectNaverSourceBundle>[2],
      signal: AbortSignal,
    ) => Promise<SourceProjection> = async (bundle, base, findings) =>
      projectNaverSourceBundle(bundle, base, findings),
  ) {}

  public create(input: CollectionJobCreateRequest): Promise<CollectionJob> {
    const execution = this.creation.then(() => this.createSerial(input));
    this.creation = execution.catch(() => undefined);
    return execution;
  }

  private async createSerial(input: CollectionJobCreateRequest): Promise<CollectionJob> {
    const request = Value.Decode(CollectionJobCreateRequestSchema, input);
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
    const selection =
      request.scope.kind === "selection"
        ? await this.workspace.collection.selection(request.scope.selectionId)
        : null;
    if (
      request.scope.kind === "selection" &&
      (selection === null || selection.entries.length === 0)
    )
      throw new InvalidCollectionRequestError("확정된 수집 대상이 없습니다.");
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
      totalItems:
        selection?.entries.length ??
        (request.scope.kind === "game_ids" ? request.scope.gameIds.length : null),
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
      persistence: Promise.resolve(),
      range:
        selection?.selection.request.range ??
        (request.scope.kind === "date_range"
          ? { startDate: request.scope.startDate, endDate: request.scope.endDate }
          : null),
      durable: false,
    };
    if (selection !== null) await this.workspace.collection.saveTargets(jobId, selection.entries);
    await this.emit(internal, "queued", "수집 작업이 대기열에 추가됐습니다.", null, "none");
    internal.durable = true;
    this.jobs.set(jobId, internal);
    this.idempotency.set(request.idempotencyKey, { fingerprint, jobId });
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

  public async restoreInterrupted(jobs: readonly CollectionJob[] = []): Promise<void> {
    if (this.jobs.size > 0) throw new Error("작업 복구는 새 manager에서만 수행할 수 있습니다.");
    const records = new Map(
      (await this.workspace.collection.histories()).map((record) => [record.job.jobId, record]),
    );
    for (const snapshot of jobs)
      if (!records.has(snapshot.jobId))
        records.set(snapshot.jobId, {
          job: snapshot,
          request: { scope: snapshot.scope, idempotencyKey: `recovered-${snapshot.jobId}` },
          sequence: 0,
          range:
            snapshot.scope.kind === "date_range"
              ? { startDate: snapshot.scope.startDate, endDate: snapshot.scope.endDate }
              : null,
        });
    for (const record of records.values()) {
      const snapshot = record.job;
      const internal: InternalJob = {
        request: record.request,
        controller: new AbortController(),
        events: [],
        listeners: new Set(),
        snapshot: cloneJob(snapshot),
        sequence: record.sequence,
        execution: Promise.resolve(),
        persistence: Promise.resolve(),
        range: record.range,
        durable: true,
      };
      this.jobs.set(snapshot.jobId, internal);
      this.idempotency.set(record.request.idempotencyKey, {
        fingerprint: canonicalStringify(record.request.scope),
        jobId: snapshot.jobId,
      });
      if (isTerminal(snapshot.status)) {
        if ((await this.workspace.collection.history(snapshot.jobId)) === null)
          await this.workspace.collection.saveHistory(record);
        continue;
      }
      const results = await this.workspace.collection.results(snapshot.jobId);
      for (const result of results) await this.workspace.collection.rememberResult(result);
      internal.snapshot = {
        ...snapshot,
        status: "failed",
        currentGameId: null,
        finishedAt: this.now().toISOString(),
        error: "서버 재시작으로 중단되었습니다. 완료 결과를 보존하며 자동 재실행하지 않습니다.",
        errorCategory: "persistence",
        completedItems: results.filter((item) => item.outcome !== "interrupted").length,
        skippedItems: results.filter((item) => item.outcome === "skipped").length,
        summary: results.reduce<CollectionJob["summary"]>(
          (summary, item) => incrementSummary(summary, item.outcome),
          { ready: 0, quarantined: 0, sourceFailures: 0, unchanged: 0 },
        ),
      };
      await this.interruptRemaining(internal);
      await this.emit(
        internal,
        "failed",
        snapshot.error ?? "API 재시작으로 작업이 중단됐습니다.",
        null,
        "none",
      );
    }
  }

  public async cancel(jobId: string): Promise<CollectionJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new JobNotFoundError("수집 작업을 찾을 수 없습니다.");
    if (isTerminal(job.snapshot.status) || job.snapshot.status === "cancelling")
      return cloneJob(job.snapshot);
    if (job.snapshot.status === "queued") {
      job.snapshot = {
        ...job.snapshot,
        status: "cancelling",
      };
      await this.emit(job, "cancelling", "대기 중인 수집 작업을 중단하고 있습니다.", null, "none");
      job.execution = this.finishQueuedCancellation(job);
    } else {
      job.snapshot = { ...job.snapshot, status: "cancelling" };
      job.controller.abort();
      await this.emit(
        job,
        "cancelling",
        "현재 경기 수집을 중단하고 있습니다.",
        job.snapshot.currentGameId,
        "none",
      );
    }
    return cloneJob(job.snapshot);
  }

  private async finishQueuedCancellation(job: InternalJob): Promise<void> {
    await this.interruptRemaining(job);
    job.snapshot = { ...job.snapshot, status: "cancelled", finishedAt: this.now().toISOString() };
    await this.emit(job, "cancelled", "대기 중인 수집 작업을 취소했습니다.", null, "none");
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
    await this.creation;
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
    const executions: Promise<void>[] = [];
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.snapshot.status)) job.controller.abort();
      if (job.execution !== null) executions.push(job.execution);
    }
    await Promise.allSettled(executions);
    await Promise.all([...this.jobs.values()].map((job) => job.persistence));
  }

  private pump(): void {
    if (this.closed) return;
    while (this.running < this.maxConcurrentJobs) {
      const next = [...this.jobs.values()].find(
        (job) => job.durable && job.snapshot.status === "queued",
      );
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
      await this.emit(job, "started", "수집 작업을 시작했습니다.", null, "none");
      const entries = await this.targets(job);
      job.snapshot = { ...job.snapshot, totalItems: entries.length };
      await this.emit(job, "progress", `${entries.length}경기를 확인했습니다.`, null, "none");
      for (const entry of entries) {
        if (job.controller.signal.aborted) throw new CollectionCancelledError();
        const gameId = entry.game.gameId;
        job.snapshot = { ...job.snapshot, currentGameId: gameId };
        await this.emit(job, "progress", "경기 자료를 수집하고 있습니다.", gameId, "none");
        let outcome: CollectionItemResult["outcome"];
        let gameDate = entry.game.gameDate;
        let label = entry.game.label;
        let message = "경기 처리를 완료했습니다.";
        try {
          if (entry.game.state === "staging")
            throw new StaleStagingDocumentError("적재 가능한 작업본의 재수집을 건너뛰었습니다.");
          await this.assertBase(entry);
          ({ outcome, gameDate, label } = await this.collectOne(job, entry));
        } catch (error: unknown) {
          if (!(error instanceof StaleStagingDocumentError)) throw error;
          outcome = "skipped";
          message = error.message;
        }
        await this.workspace.collection.saveResult(job.snapshot.jobId, {
          gameId,
          gameDate,
          label,
          outcome,
          message,
          finishedAt: this.now().toISOString(),
        });
        job.snapshot = {
          ...job.snapshot,
          completedItems: job.snapshot.completedItems + 1,
          currentGameId: null,
          skippedItems: job.snapshot.skippedItems + (outcome === "skipped" ? 1 : 0),
          summary: incrementSummary(job.snapshot.summary, outcome),
        };
        await this.workspace.saveCollectionJobJournal(job.snapshot);
        await this.emit(
          job,
          "game_completed",
          message,
          gameId,
          outcome === "ready" || outcome === "quarantined" || outcome === "source_failure"
            ? outcome
            : "none",
        );
      }
      job.snapshot = {
        ...job.snapshot,
        status: "succeeded",
        currentGameId: null,
        finishedAt: this.now().toISOString(),
      };
      await this.emit(job, "succeeded", "수집 작업을 완료했습니다.", null, "none");
    } catch (error: unknown) {
      if (error instanceof CollectionCancelledError || job.controller.signal.aborted) {
        job.snapshot = {
          ...job.snapshot,
          status: "cancelled",
          currentGameId: null,
          finishedAt: this.now().toISOString(),
        };
        await this.interruptRemaining(job);
        await this.emit(job, "cancelled", "수집 작업이 취소됐습니다.", null, "none");
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
        await this.interruptRemaining(job);
        await this.emit(job, "failed", message, null, "none");
      }
    } finally {
      if (
        journalCreated &&
        (await this.workspace.collection.history(job.snapshot.jobId))?.job.status ===
          job.snapshot.status
      ) {
        await this.workspace.removeCollectionJobJournal(job.snapshot.jobId).catch(() => undefined);
      }
    }
  }

  private async targets(job: InternalJob): Promise<CollectionSelectionEntry[]> {
    const scope = job.request.scope;
    if (scope.kind === "selection") return this.workspace.collection.targets(job.snapshot.jobId);
    const schedule =
      scope.kind === "date_range"
        ? await this.explorer.discoverRange(scope.startDate, scope.endDate, job.controller.signal)
        : [];
    const ids = scope.kind === "game_ids" ? scope.gameIds : schedule.map((entry) => entry.gameId);
    const catalog = new Map(
      (await this.workspace.catalog()).games.map((game) => [game.gameId, game]),
    );
    const scheduled = new Map(schedule.map((entry) => [entry.gameId, entry]));
    const entries: CollectionSelectionEntry[] = [];
    for (const gameId of ids) {
      const game = catalog.get(gameId),
        entry = scheduled.get(gameId);
      const base = await this.findCurrentRevisionBase(gameId);
      entries.push({
        workspaceToken: await this.workspace.collectionToken(gameId),
        game: {
          gameId,
          gameDate:
            game !== undefined && game.authority !== "source_failure"
              ? game.gameDate
              : (entry?.gameDate ?? null),
          label:
            game !== undefined && game.authority !== "source_failure"
              ? `${game.teams.away.name} vs ${game.teams.home.name}`
              : (entry?.label ?? gameId),
          scheduledAt: entry?.scheduledAt ?? null,
          state: game?.authority ?? (base === null ? "uncollected" : "database"),
          databaseRevision: base?.revision ?? null,
          workspace: game ?? null,
          updatedAt: game?.updatedAt ?? null,
          blockingFindings: game?.blockingFindings ?? 0,
          warningFindings: game?.warningFindings ?? 0,
        },
      });
    }
    await this.workspace.collection.saveTargets(job.snapshot.jobId, entries);
    return entries;
  }

  private async assertBase(entry: CollectionSelectionEntry): Promise<CurrentRevisionBase | null> {
    const token = await this.workspace.collectionToken(entry.game.gameId);
    const base = await this.findCurrentRevisionBase(entry.game.gameId);
    if (
      token !== entry.workspaceToken ||
      (base?.revision ?? null) !== entry.game.databaseRevision
    ) {
      throw new StaleStagingDocumentError(
        "선택 이후 작업본 또는 DB 저장 상태가 바뀌어 건너뛰었습니다.",
      );
    }
    return base;
  }

  private async interruptRemaining(job: InternalJob): Promise<void> {
    const done = new Set(
      (await this.workspace.collection.results(job.snapshot.jobId)).map((item) => item.gameId),
    );
    const targets = await this.workspace.collection.targets(job.snapshot.jobId);
    const games =
      targets.length > 0
        ? targets.map((entry) => entry.game)
        : job.request.scope.kind === "game_ids"
          ? job.request.scope.gameIds.map((gameId) => ({ gameId, gameDate: null, label: gameId }))
          : [];
    for (const game of games) {
      if (!done.has(game.gameId))
        await this.workspace.collection.saveResult(job.snapshot.jobId, {
          gameId: game.gameId,
          gameDate: game.gameDate,
          label: game.label,
          outcome: "interrupted",
          message: "처리 완료를 확인하지 못했습니다. 재시도 시 현재 저장 상태를 다시 확인합니다.",
          finishedAt: this.now().toISOString(),
        });
    }
  }

  private async collectOne(
    job: InternalJob,
    entry: CollectionSelectionEntry,
  ): Promise<Pick<CollectionItemResult, "outcome" | "gameDate" | "label">> {
    const gameId = entry.game.gameId;
    let gameDate = entry.game.gameDate;
    let label = entry.game.label;
    const collected = await this.collector.collect(gameId, job.controller.signal);
    const outcome = await this.workspace.withGameOperation(gameId, async () => {
      if (job.controller.signal.aborted) throw new CollectionCancelledError();
      await this.assertBase(entry);
      if (collected.disposition === "source_failure" || collected.bundle === null) {
        await this.workspace.saveSourceFailure(
          gameId,
          collected.findings.map(storedSourceFinding),
          null,
          entry.workspaceToken,
        );
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
        const currentBase = await this.assertBase(entry);
        if (currentBase?.sourceBundleHash === sourceBundleHash) return "unchanged";
        const { document, findings } = await this.projectSource(
          collected.bundle,
          currentBase,
          collected.findings,
          job.controller.signal,
        );
        gameDate = document.metadata.gameDate;
        label = `${document.teams.away.name} vs ${document.teams.home.name}`;
        await this.assertBase(entry);
        if (findings.some((finding) => finding.severity === "blocking")) {
          await this.workspace.saveQuarantine(document, findings, entry.workspaceToken);
          return "quarantined";
        }
        await this.workspace.saveReady(document, findings, entry.workspaceToken);
        return "ready";
      } catch (error: unknown) {
        if (error instanceof StaleStagingDocumentError) throw error;
        if (!(error instanceof NaverSourceFormatError)) throw error;
        const message = error.message;
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
          entry.workspaceToken,
        );
        return "source_failure";
      }
    });
    return { outcome, gameDate, label };
  }

  private async emit(
    job: InternalJob,
    type: JobEvent["type"],
    message: string,
    gameId: string | null,
    disposition: JobEvent["payload"]["disposition"],
  ): Promise<void> {
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
    const record = structuredClone({
      job: job.snapshot,
      request: job.request,
      sequence: job.sequence,
      range: job.range,
    });
    job.persistence = job.persistence.then(() => this.workspace.collection.saveHistory(record));
    await job.persistence;
    job.events.push(event);
    if (job.events.length > 2_000) job.events.shift();
    for (const listener of job.listeners) listener(event);
  }
}

function incrementSummary(
  summary: CollectionJob["summary"],
  disposition: CollectionItemResult["outcome"],
): CollectionJob["summary"] {
  return {
    ready: summary.ready + (disposition === "ready" ? 1 : 0),
    quarantined: summary.quarantined + (disposition === "quarantined" ? 1 : 0),
    sourceFailures: summary.sourceFailures + (disposition === "source_failure" ? 1 : 0),
    unchanged: (summary.unchanged ?? 0) + (disposition === "unchanged" ? 1 : 0),
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
