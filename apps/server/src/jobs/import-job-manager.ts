import { createHash, randomUUID } from "node:crypto";
import {
  canonicalStringify,
  compareCanonicalStrings,
  type GameCatalog,
  type ImportJob,
  type ImportJobCreateRequest,
  type ImportReadyBatchCreated,
  type ImportReadyBatchCreateRequest,
  type StagingGameDocumentV2,
  type ImportSelectionRequest,
  type ImportSelection,
  type ImportSelectionRecord,
  type ImportTarget,
  type ImportJobRecord,
  type ImportHistoryQuery,
  type ImportHistory,
  type RevisionCatalog,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import {
  BlockingImportError,
  GameAlreadyImportedError,
  RevisionConflictError,
  type ImportedRevision,
  type ImportOptions,
  type ImportWorkspace,
} from "@kbo/persistence";
import { ImportHistoryIndex, isTerminal } from "./import-history-index.js";

interface ImportSourceWorkspace {
  readonly imports?: ImportWorkspace;
  withGameOperation?<T>(gameId: string, operation: () => Promise<T>): Promise<T>;
  catalog(gameIds?: readonly string[]): Promise<GameCatalog>;
  readImportInput?(
    gameId: string,
  ): Promise<{ document: StagingGameDocumentV2; target: ImportTarget } | null>;
  readImportTarget?(gameId: string): Promise<ImportTarget | null>;
  readImportTargets?(gameIds: readonly string[]): Promise<ImportTarget[]>;
  readDocument(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<StagingGameDocumentV2>;
  removeImportedStaging?(
    season: number,
    gameId: string,
    expectedDocumentHash: string,
    artifact?: ImportTarget["artifact"],
  ): Promise<void>;
}
interface RevisionImporter {
  importRevision(input: unknown, options?: ImportOptions): Promise<ImportedRevision>;
  revisions?(gameId: string): Promise<RevisionCatalog>;
  importPublication?(jobId: string, target: ImportTarget): Promise<ImportedRevision | null>;
}
interface InternalImportJob {
  readonly request: ImportJobCreateRequest;
  sourceSeason: number | null;
  target: ImportTarget | null;
  snapshot: ImportJob;
  execution: ImportReservation | null;
  settlement?: Promise<void>;
  cancellation?: Promise<void>;
  followUp?: Promise<void>;
  cleaningArtifact?: true;
  publicationPending?: true;
  publicationFailure?: ImportJobRecord["publicationFailure"];
  retryDelay?: number;
}
interface ImportReservation {
  phase: "waiting" | "running";
  completion?: Promise<void>;
}
interface ImportFollowUpQueue {
  readonly pending: (() => Promise<void>)[];
  active: number;
}
type ImportExecution =
  | { readonly kind: "sealed"; readonly result: ImportedRevision }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "deferred" }
  | { readonly kind: "storageFailure"; readonly error: unknown };

export class ImportJobNotFoundError extends Error {}
export class ImportIdempotencyConflictError extends Error {}
export class ImportSourceNotReadyError extends Error {}

export class ImportJobManager {
  private readonly jobs = new Map<string, InternalImportJob>();
  private readonly jobIdsByGame = new Map<string, Set<string>>();
  private readonly retainedJobs = new Map<string, ImportJob>();
  private readonly historyIndex = new ImportHistoryIndex();
  private readonly pendingJobIds: string[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  private readonly batches = new Map<
    string,
    { fingerprint: string; result: ImportReadyBatchCreated }
  >();
  private readonly selections = new Map<string, ImportSelectionRecord>();
  private creationTail: Promise<unknown> = Promise.resolve();
  private cancellationTail: Promise<unknown> = Promise.resolve();
  private readonly executingGames = new Set<string>();
  private readonly retries = new Map<InternalImportJob, number>();
  private readonly fileCleanups: ImportFollowUpQueue = { pending: [], active: 0 };
  private readonly reevaluations: ImportFollowUpQueue = { pending: [], active: 0 };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retrying = false;
  private closed = false;

  public constructor(
    private readonly workspace: ImportSourceWorkspace,
    private readonly importer: RevisionImporter,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly maxConcurrentJobs = 2,
    private readonly onSucceeded: (
      gameId: string,
      revision: number,
      documentHash: string,
    ) => Promise<void> = async () => undefined,
    private readonly verifyRecordCorrection?: (
      document: StagingGameDocumentV2,
      target: ImportTarget,
    ) => Promise<number | undefined>,
  ) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1)
      throw new Error("동시 적재 작업 수는 1 이상의 정수여야 합니다.");
  }

  public async restore({ background = false } = {}): Promise<void> {
    const storage = this.workspace.imports;
    if (storage === undefined) return;
    for (const job of await storage.retainedJobs()) {
      this.retainedJobs.set(job.jobId, job);
      if (!this.jobs.has(job.jobId)) this.historyIndex.upsert(job);
    }
    for (const record of await storage.batches()) {
      this.batches.set(record.request.idempotencyKey, {
        fingerprint: batchFingerprint(record.request),
        result: record.batch,
      });
      for (const job of record.records) this.register(job);
    }
    for (const record of await storage.jobs()) this.register(record);
    for (const job of this.jobs.values()) {
      if (
        job.publicationPending !== true &&
        isTerminal(job.snapshot.status) &&
        job.snapshot.followUpPending !== true
      )
        continue;
      if (job.snapshot.status === "succeeded") {
        const followUp = this.queueFollowUp(job);
        if (!background) await followUp;
      } else if (background) this.enqueueCheck(job, 0);
      else {
        await this.settle(job);
        await job.followUp;
      }
    }
  }

  private settle(job: InternalImportJob, outcome?: ImportExecution): Promise<void> {
    if (job.execution !== null) return Promise.resolve();
    if (job.cancellation !== undefined) return job.cancellation;
    if (job.settlement !== undefined) return job.settlement;
    this.retries.delete(job);
    const pending = Promise.resolve()
      .then(() => this.settleJob(job, outcome))
      .catch((error: unknown) => this.storageFailed(job, error))
      .finally(() => {
        delete job.settlement;
        if (job.snapshot.status === "succeeded" && job.snapshot.followUpPending === true)
          void this.queueFollowUp(job);
        this.armRetryTimer();
        this.schedule();
      });
    job.settlement = pending;
    return pending;
  }

  private async settleJob(job: InternalImportJob, outcome?: ImportExecution): Promise<void> {
    if (job.snapshot.status === "succeeded") return;
    if (outcome?.kind === "storageFailure") {
      this.storageFailed(job, outcome.error);
      return;
    }
    if (outcome?.kind === "sealed") {
      await this.recordPublication(job, outcome.result);
      return;
    }
    if (isTerminal(job.snapshot.status) && job.publicationPending !== true) return;
    const failure =
      outcome?.kind === "failed"
        ? this.describeFailure(job, outcome.error)
        : job.publicationFailure;
    // Queued records never entered the database. Older running records may still need a receipt lookup.
    if (
      job.publicationPending === true ||
      (outcome === undefined && job.snapshot.status === "running")
    ) {
      let receipt: ImportedRevision | null;
      try {
        receipt = await this.committedPublication(job);
      } catch (error: unknown) {
        if (error instanceof RevisionConflictError) {
          await this.fail(job, {
            status: "failed",
            error: error.message,
            errorCategory: "persistence",
          });
          return;
        }
        await this.writeState(
          job,
          {
            ...job.snapshot,
            status: "running",
            publicationCheckPending: true,
            revision: null,
            documentHash: null,
            projectionHash: null,
            finishedAt: null,
            error: "DB 봉인 결과를 아직 확인하지 못했습니다. 결과를 다시 확인합니다.",
            errorCategory: "persistence",
          },
          true,
          failure,
        );
        const delay = job.retryDelay ?? 1000;
        job.retryDelay = Math.min(delay * 2, 30000);
        this.enqueueCheck(job, delay);
        return;
      }
      if (receipt !== null) {
        await this.recordPublication(job, receipt);
        return;
      }
    }
    if (failure !== undefined) await this.fail(job, failure);
    else
      await this.fail(
        job,
        {
          status: "cancelled",
          error: "봉인 기록이 확인되지 않은 중단 작업입니다. 현재 상태를 확인해 다시 선택하세요.",
          errorCategory: "persistence",
        },
        true,
      );
  }

  private enqueueCheck(job: InternalImportJob, delay: number): void {
    if (this.closed) return;
    this.retries.set(job, Date.now() + delay);
    this.armRetryTimer();
  }

  private armRetryTimer(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.closed || this.retrying || this.retries.size === 0) return;
    const first = [...this.retries].reduce((earliest, item) =>
      item[1] < earliest[1] ? item : earliest,
    );
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        this.retrying = true;
        void this.settle(first[0]).finally(() => {
          this.retrying = false;
          this.armRetryTimer();
        });
      },
      Math.max(0, first[1] - Date.now()),
    );
    this.retryTimer.unref();
  }

  private storageFailed(job: InternalImportJob, error: unknown): void {
    this.closed = true;
    this.armRetryTimer();
    this.setSnapshot(job, {
      ...job.snapshot,
      ...(job.snapshot.status === "succeeded"
        ? {}
        : job.publicationPending === true
          ? { status: "running" as const, publicationCheckPending: true as const }
          : { status: "failed" as const, finishedAt: this.now().toISOString() }),
      error: `적재 이력 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
      errorCategory: "persistence",
    });
    for (const pending of this.jobs.values()) {
      if (
        pending.snapshot.status !== "queued" ||
        pending.execution !== null ||
        pending.settlement !== undefined ||
        pending.cancellation !== undefined
      )
        continue;
      this.setSnapshot(pending, {
        ...pending.snapshot,
        status: "cancelled",
        interrupted: true,
        finishedAt: this.now().toISOString(),
        error: "이력 저장 장치 오류로 실행하지 않았습니다. 서버 복구 후 다시 선택하세요.",
        errorCategory: "persistence",
      });
    }
  }

  private async committedPublication(job: InternalImportJob): Promise<ImportedRevision | null> {
    const target = job.target;
    if (target === null) return null;
    if (this.importer.importPublication !== undefined)
      return this.importer.importPublication(job.snapshot.jobId, target);
    const revisions = await this.importer.revisions?.(target.gameId);
    const committed = revisions?.revisions.find(
      (revision) =>
        revision.sealed &&
        revision.revision === target.revision &&
        revision.documentHash === target.documentHash,
    );
    return committed === undefined ? null : { ...committed, gameId: target.gameId };
  }

  private async recordPublication(
    job: InternalImportJob,
    imported: ImportedRevision,
  ): Promise<void> {
    const previous = { ...job.snapshot };
    delete previous.publicationCheckPending;
    const confirmed: ImportJob = {
      ...previous,
      status: "succeeded",
      finishedAt: previous.finishedAt ?? this.now().toISOString(),
      revision: imported.revision,
      documentHash: imported.documentHash,
      projectionHash: imported.projectionHash,
      followUpPending: true,
      error: null,
      errorCategory: null,
    };
    try {
      await this.writeState(job, confirmed);
    } catch (error: unknown) {
      // Keep the dispatch journal until the confirmed result can be persisted for restart.
      this.storageFailed(
        job,
        new Error("DB 봉인은 확인됐습니다. 서버 복구 후 적재 이력을 다시 확인하세요.", {
          cause: error,
        }),
      );
    }
  }

  private describeFailure(
    job: InternalImportJob,
    error: unknown,
  ): NonNullable<ImportJobRecord["publicationFailure"]> {
    return {
      status:
        error instanceof ImportSourceNotReadyError && job.target !== null ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : "알 수 없는 적재 오류",
      errorCategory:
        error instanceof ImportSourceNotReadyError ||
        error instanceof BlockingImportError ||
        error instanceof GameAlreadyImportedError ||
        error instanceof RevisionConflictError
          ? "domain"
          : "persistence",
    };
  }

  private fail(
    job: InternalImportJob,
    failure: NonNullable<ImportJobRecord["publicationFailure"]>,
    interrupted = false,
  ): Promise<void> {
    const previous = { ...job.snapshot };
    delete previous.publicationCheckPending;
    return this.writeState(job, {
      ...previous,
      ...failure,
      ...(interrupted ? { interrupted: true } : {}),
      revision: null,
      documentHash: null,
      projectionHash: null,
      finishedAt: this.now().toISOString(),
    });
  }

  private async writeState(
    job: InternalImportJob,
    snapshot: ImportJob,
    publicationPending?: true,
    publicationFailure?: ImportJobRecord["publicationFailure"],
  ): Promise<void> {
    await this.workspace.imports?.saveJob({
      request: job.request,
      sourceSeason: job.sourceSeason,
      target: job.target,
      job: snapshot,
      ...(publicationPending ? { publicationPending } : {}),
      ...(publicationFailure === undefined ? {} : { publicationFailure }),
    });
    this.setSnapshot(job, snapshot);
    if (publicationPending) job.publicationPending = true;
    else delete job.publicationPending;
    if (publicationFailure !== undefined) job.publicationFailure = publicationFailure;
    else delete job.publicationFailure;
  }

  private setSnapshot(job: InternalImportJob, snapshot: ImportJob): void {
    job.snapshot = snapshot;
    if (this.jobs.get(snapshot.jobId) === job) this.historyIndex.upsert(snapshot);
  }

  public create(request: ImportJobCreateRequest): Promise<ImportJob> {
    return this.serializeCreation(async () => {
      this.assertOpen();
      const existing = this.idempotency.get(request.idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== jobFingerprint(request))
          throw new ImportIdempotencyConflictError(
            "같은 idempotency key에 다른 경기 또는 문서가 지정되었습니다.",
          );
        return this.get(existing.jobId);
      }
      const target = (await this.workspace.readImportTarget?.(request.gameId)) ?? null;
      if (this.hasUnconfirmedGame(request.gameId, undefined, true))
        throw new ImportSourceNotReadyError("같은 경기의 선행 적재 결과를 확인하고 있습니다.");
      if (this.isCleaningTarget(request.gameId, target))
        throw new ImportSourceNotReadyError("같은 작업본의 적재 후 정리가 진행 중입니다.");
      const job = this.prepare(request, target);
      await this.save(job);
      this.register(this.record(job));
      this.pendingJobIds.push(job.snapshot.jobId);
      queueMicrotask(() => this.schedule());
      return { ...job.snapshot };
    });
  }

  public async createSelection(criteria: ImportSelectionRequest): Promise<ImportSelection> {
    this.assertOpen();
    if (criteria.selectionId !== undefined) {
      const parent =
        this.selections.get(criteria.selectionId) ??
        (await this.workspace.imports?.selection(criteria.selectionId));
      if (parent === null || parent === undefined)
        throw new ImportSourceNotReadyError("기존 적재 선택을 찾을 수 없습니다.");
      const excluded = new Set(criteria.excludedGameIds ?? []);
      const targets = parent.targets.filter(
        (target) =>
          !excluded.has(target.gameId) &&
          (criteria.gameIds === undefined || criteria.gameIds.includes(target.gameId)),
      );
      const selection: ImportSelection = {
        selectionId: this.newId(),
        createdAt: this.now().toISOString(),
        count: targets.length,
        criteria,
      };
      const record = { selection, targets };
      await this.workspace.imports?.saveSelection(record);
      this.selections.set(selection.selectionId, record);
      return selection;
    }
    const catalog = await this.workspace.catalog(criteria.gameIds);
    const included = criteria.gameIds === undefined ? null : new Set(criteria.gameIds);
    const excluded = new Set(criteria.excludedGameIds ?? []);
    const search = (criteria.search ?? "").trim().toLocaleLowerCase("ko-KR");
    const candidates = catalog.games
      .filter(
        (game) =>
          game.authority === "staging" &&
          (criteria.season === undefined || game.season === criteria.season) &&
          (included === null || included.has(game.gameId)) &&
          !excluded.has(game.gameId) &&
          !this.hasActiveJob(game.gameId) &&
          (search === "" ||
            `${game.gameId} ${"gameDate" in game ? game.gameDate : ""} ${"teams" in game ? `${game.teams.away.name} ${game.teams.home.name}` : ""}`
              .toLocaleLowerCase("ko-KR")
              .includes(search)),
      )
      .sort((a, b) => compareCanonicalStrings(a.gameId, b.gameId));
    if (candidates.length > 50_000)
      throw new ImportSourceNotReadyError("한 번에 선택할 수 있는 경기는 50,000개입니다.");
    const targets =
      this.workspace.readImportTargets === undefined
        ? []
        : await this.workspace.readImportTargets(candidates.map((game) => game.gameId));
    if (this.workspace.readImportTargets === undefined) {
      for (const game of candidates) {
        if (game.season === null) continue;
        const document = await this.workspace.readDocument("staging", game.season, game.gameId);
        targets.push(targetOf(document));
      }
    }
    const available = targets.filter(
      (target) =>
        !this.hasActiveJob(target.gameId) && !this.isCleaningTarget(target.gameId, target),
    );
    const selection: ImportSelection = {
      selectionId: this.newId(),
      createdAt: this.now().toISOString(),
      count: available.length,
      criteria,
    };
    const record = { selection, targets: available };
    await this.workspace.imports?.saveSelection(record);
    this.selections.set(selection.selectionId, record);
    return selection;
  }

  public createReadyBatch(
    request: ImportReadyBatchCreateRequest,
  ): Promise<ImportReadyBatchCreated> {
    return this.serializeCreation(async () => {
      this.assertOpen();
      const fingerprint = batchFingerprint(request);
      const existing = this.batches.get(request.idempotencyKey);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint)
          throw new ImportIdempotencyConflictError(
            "같은 요청 키에 다른 적재 선택이 지정되었습니다.",
          );
        return cloneBatch(existing.result);
      }
      // 이전 API는 유지하며 새 UI는 확인한 선택 ID만 제출한다.
      const selectionId = request.selectionId ?? (await this.createSelection({})).selectionId;
      const selected =
        this.selections.get(selectionId) ?? (await this.workspace.imports?.selection(selectionId));
      if (selected === undefined || selected === null)
        throw new ImportSourceNotReadyError("확정한 적재 대상을 찾을 수 없습니다.");
      const batchId = this.newId();
      const jobs = selected.targets
        .filter(
          (target) =>
            !this.hasActiveJob(target.gameId) && !this.isCleaningTarget(target.gameId, target),
        )
        .map((target) =>
          this.prepare(
            {
              gameId: target.gameId,
              idempotencyKey: createHash("sha256")
                .update(`${request.idempotencyKey}:${target.gameId}`)
                .digest("hex"),
            },
            target,
            batchId,
          ),
        );
      const result: ImportReadyBatchCreated = {
        batchId,
        createdCount: jobs.length,
        skippedCount: selected.targets.length - jobs.length,
        jobs: jobs.map((job) => ({
          jobId: job.snapshot.jobId,
          gameId: job.snapshot.gameId,
          status: job.snapshot.status,
        })),
      };
      // 전체 실행 의도를 한 번 원자적으로 기록한 뒤에만 큐를 공개한다.
      await this.workspace.imports?.saveBatch({
        request,
        batch: result,
        records: jobs.map((job) => this.record(job)),
      });
      this.batches.set(request.idempotencyKey, { fingerprint, result });
      for (const job of jobs) {
        this.register(this.record(job));
        this.pendingJobIds.push(job.snapshot.jobId);
      }
      queueMicrotask(() => this.schedule());
      return cloneBatch(result);
    });
  }

  public get(jobId: string): ImportJob {
    const retained = this.retainedJobs.get(jobId);
    if (!this.jobs.has(jobId) && retained !== undefined) return { ...retained };
    return { ...this.internal(jobId).snapshot };
  }
  public list(): readonly ImportJob[] {
    return this.historyIndex.list();
  }
  public history(query: ImportHistoryQuery): ImportHistory {
    return this.historyIndex.read(query);
  }
  public async cancel(jobId: string): Promise<ImportJob> {
    const job = this.internal(jobId);
    await this.cancelQueued(job);
    return this.get(jobId);
  }

  public async cancelBatch(batchId: string): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => job.snapshot.batchId === batchId)
        .map((job) => this.cancelQueued(job)),
    );
  }

  private cancelQueued(job: InternalImportJob): Promise<void> | undefined {
    if (job.cancellation !== undefined) return job.cancellation;
    if (
      job.snapshot.status !== "queued" ||
      job.execution?.phase === "running" ||
      job.settlement !== undefined
    )
      return undefined;
    const cancellation = this.cancellationTail
      .then(() =>
        this.writeState(job, {
          ...job.snapshot,
          status: "cancelled",
          finishedAt: this.now().toISOString(),
          error: "대기 중 취소했습니다.",
          errorCategory: null,
        }),
      )
      .catch((error: unknown) => {
        this.storageFailed(job, error);
        throw error;
      })
      .finally(() => {
        delete job.cancellation;
        this.schedule();
      });
    job.cancellation = cancellation;
    if (job.execution !== null) this.releaseReservation(job);
    this.cancellationTail = cancellation.catch(() => undefined);
    return cancellation;
  }

  public async reconcile(jobId: string, scope?: "publication"): Promise<ImportJob> {
    const job = this.internal(jobId);
    if (!this.closed) {
      if (job.publicationPending === true || job.snapshot.publicationCheckPending === true)
        await this.settle(job);
      else if (
        scope !== "publication" &&
        job.snapshot.status === "succeeded" &&
        job.snapshot.followUpPending === true
      )
        await this.queueFollowUp(job);
    }
    return this.get(jobId);
  }

  public async waitForTerminal(jobId: string): Promise<ImportJob> {
    const job = this.internal(jobId);
    while (job.snapshot.status === "queued" && job.execution === null && !this.closed)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await job.execution?.completion;
    await job.settlement;
    await job.followUp;
    return this.get(jobId);
  }

  public hasImportActivity(): boolean {
    return (
      this.executingGames.size > 0 ||
      this.pendingJobIds.some((id) => {
        const job = this.jobs.get(id);
        return (
          job?.snapshot.status === "queued" &&
          job.cancellation === undefined &&
          !this.hasUnconfirmedGame(job.snapshot.gameId, id) &&
          !this.isCleaningTarget(job.snapshot.gameId, job.target, id)
        );
      })
    );
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.armRetryTimer();
    this.retries.clear();
    this.runFollowUps(this.fileCleanups);
    this.runFollowUps(this.reevaluations);
    await this.creationTail;
    await Promise.allSettled([...this.jobs.values()].map((job) => this.cancelQueued(job)));
    await Promise.allSettled(
      [...this.jobs.values()].flatMap((job) => [
        job.execution?.completion,
        job.settlement,
        job.followUp,
      ]),
    );
  }

  private prepare(
    request: ImportJobCreateRequest,
    target: ImportTarget | null,
    batchId?: string,
  ): InternalImportJob {
    return {
      request,
      target,
      sourceSeason: target?.season ?? null,
      execution: null,
      snapshot: {
        jobId: this.newId(),
        kind: "import",
        status: "queued",
        gameId: request.gameId,
        createdAt: this.now().toISOString(),
        startedAt: null,
        finishedAt: null,
        revision: null,
        documentHash: null,
        projectionHash: null,
        error: null,
        errorCategory: null,
        ...(batchId === undefined ? {} : { batchId }),
      },
    };
  }
  private register(record: ImportJobRecord): void {
    this.jobs.set(record.job.jobId, {
      request: record.request,
      sourceSeason: record.sourceSeason,
      target: record.target,
      snapshot: record.job,
      ...(record.publicationPending ? { publicationPending: true as const } : {}),
      ...(record.publicationFailure === undefined
        ? {}
        : { publicationFailure: record.publicationFailure }),
      execution: null,
    });
    this.historyIndex.upsert(record.job);
    const gameIds = this.jobIdsByGame.get(record.job.gameId) ?? new Set<string>();
    gameIds.add(record.job.jobId);
    this.jobIdsByGame.set(record.job.gameId, gameIds);
    this.idempotency.set(record.request.idempotencyKey, {
      fingerprint: jobFingerprint(record.request),
      jobId: record.job.jobId,
    });
  }
  private record(job: InternalImportJob): ImportJobRecord {
    return {
      request: job.request,
      sourceSeason: job.sourceSeason,
      target: job.target,
      job: job.snapshot,
      ...(job.publicationPending ? { publicationPending: true as const } : {}),
      ...(job.publicationFailure === undefined
        ? {}
        : { publicationFailure: job.publicationFailure }),
    };
  }
  private async save(job: InternalImportJob): Promise<void> {
    await this.workspace.imports?.saveJob(this.record(job));
  }
  private internal(id: string): InternalImportJob {
    const job = this.jobs.get(id);
    if (job === undefined) throw new ImportJobNotFoundError("적재 작업을 찾을 수 없습니다.");
    return job;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("종료 중에는 적재 작업을 만들 수 없습니다.");
  }
  private serializeCreation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.creationTail.then(operation);
    this.creationTail = pending.catch(() => undefined);
    return pending;
  }
  private *gameJobs(gameId: string, exclude?: string): Iterable<InternalImportJob> {
    for (const id of this.jobIdsByGame.get(gameId) ?? []) {
      const job = this.jobs.get(id);
      if (id !== exclude && job !== undefined) yield job;
    }
  }

  private hasActiveJob(gameId: string): boolean {
    for (const job of this.gameJobs(gameId)) if (!isTerminal(job.snapshot.status)) return true;
    return false;
  }

  private hasUnconfirmedGame(gameId: string, exclude?: string, inactiveOnly = false): boolean {
    for (const job of this.gameJobs(gameId, exclude)) {
      if (job.publicationPending === true && (!inactiveOnly || job.execution === null)) return true;
      if (!inactiveOnly && job.settlement !== undefined && job.snapshot.status === "running")
        return true;
    }
    return false;
  }

  private isCleaningTarget(gameId: string, target: ImportTarget | null, exclude?: string): boolean {
    for (const job of this.gameJobs(gameId, exclude)) {
      if (job.cleaningArtifact !== true) continue;
      if (target === null || job.target === null) return true;
      if (
        target.documentHash === job.target.documentHash &&
        target.artifact?.generation === job.target.artifact?.generation &&
        target.artifact?.contentHash === job.target.artifact?.contentHash
      )
        return true;
    }
    return false;
  }

  private schedule(): void {
    if (this.closed) return;
    let remaining = this.pendingJobIds.length;
    while (remaining-- > 0 && this.executingGames.size < this.maxConcurrentJobs) {
      const id = this.pendingJobIds.shift();
      if (id === undefined) return;
      const job = this.jobs.get(id);
      if (
        job === undefined ||
        job.execution !== null ||
        job.settlement !== undefined ||
        job.cancellation !== undefined ||
        job.snapshot.status !== "queued"
      )
        continue;
      const gameId = job.snapshot.gameId;
      if (
        this.executingGames.has(gameId) ||
        this.hasUnconfirmedGame(gameId, id) ||
        this.isCleaningTarget(gameId, job.target, id)
      ) {
        this.pendingJobIds.push(id);
        continue;
      }
      this.executingGames.add(gameId);
      const reservation: ImportReservation = { phase: "waiting" };
      job.execution = reservation;
      reservation.completion = this.run(job, reservation).then(
        (outcome) => {
          if (job.execution !== reservation) return;
          this.releaseReservation(job);
          if (outcome.kind === "deferred") {
            if (this.closed) return this.cancelQueued(job);
            if (job.cancellation === undefined && job.snapshot.status === "queued")
              this.pendingJobIds.push(id);
            this.schedule();
            return;
          }
          const settlement = this.settle(job, outcome);
          this.schedule();
          return settlement;
        },
        (error: unknown) => {
          if (job.execution !== reservation) return;
          this.releaseReservation(job);
          this.storageFailed(job, error);
        },
      );
    }
  }

  private releaseReservation(job: InternalImportJob): void {
    job.execution = null;
    this.executingGames.delete(job.snapshot.gameId);
  }

  private async run(
    job: InternalImportJob,
    reservation: ImportReservation,
  ): Promise<ImportExecution> {
    const gameId = job.snapshot.gameId;
    return this.withGame(gameId, async () => {
      if (
        this.closed ||
        job.execution !== reservation ||
        job.snapshot.status !== "queued" ||
        this.hasUnconfirmedGame(gameId, job.snapshot.jobId) ||
        this.isCleaningTarget(gameId, job.target, job.snapshot.jobId)
      )
        return { kind: "deferred" };
      reservation.phase = "running";
      await this.writeState(job, {
        ...job.snapshot,
        status: "running",
        startedAt: this.now().toISOString(),
      });
      try {
        if (job.target === null && this.workspace.readImportTarget !== undefined)
          throw new ImportSourceNotReadyError("접수 시 적재 가능 작업본이 없었습니다.");
        const input =
          this.workspace.readImportInput === undefined
            ? await this.readLegacyImportInput(gameId)
            : await this.workspace.readImportInput(gameId);
        if (input === null)
          throw new ImportSourceNotReadyError("staging ready 상태인 경기를 찾을 수 없습니다.");
        const { document, target } = input;
        if (
          job.request.expectedDocumentHash !== undefined &&
          job.request.expectedDocumentHash !== target.documentHash
        )
          throw new ImportSourceNotReadyError(
            "보정 저장 이후 문서가 변경되었습니다. 현재 문서를 다시 확인하세요.",
          );
        if (job.target !== null && canonicalStringify(job.target) !== canonicalStringify(target))
          throw new ImportSourceNotReadyError(
            "선택 이후 보정 문서가 변경되어 건너뛰었습니다. 다시 확인하고 선택하세요.",
          );
        job.target = target;
        job.sourceSeason = document.metadata.season;
        const verifiedMatchupGeneration = await this.verifyRecordCorrection?.(document, target);
        const publication = this.importer.importPublication !== undefined;
        if (publication && target.artifact === undefined)
          throw new ImportSourceNotReadyError("저장된 작업본의 적재 식별자가 없습니다.");
        try {
          await this.writeState(job, job.snapshot, publication ? true : undefined);
        } catch (error: unknown) {
          return { kind: "storageFailure", error };
        }
        const options: ImportOptions = {
          ...(publication ? { publication: { jobId: job.snapshot.jobId, target } } : {}),
          ...(target.recordCorrection === undefined
            ? {}
            : {
                recordCorrectionApprovals: target.recordCorrection.approvals,
                ...(target.recordCorrection.fromSealedDraft
                  ? { fromIndependentSealedDraft: true as const }
                  : {}),
              }),
          ...(verifiedMatchupGeneration === undefined ? {} : { verifiedMatchupGeneration }),
        };
        const imported =
          Object.keys(options).length === 0
            ? await this.importer.importRevision(document)
            : await this.importer.importRevision(document, options);
        return { kind: "sealed", result: imported };
      } catch (error: unknown) {
        return { kind: "failed", error };
      }
    });
  }

  private queueFollowUp(job: InternalImportJob): Promise<void> | undefined {
    if (this.closed) return job.followUp;
    if (job.followUp !== undefined) return job.followUp;
    job.cleaningArtifact = true;
    const followUp = this.finishFollowUp(job)
      .catch((error: unknown) => this.storageFailed(job, error))
      .finally(() => {
        delete job.followUp;
        delete job.cleaningArtifact;
        this.schedule();
      });
    job.followUp = followUp;
    return followUp;
  }

  private followUpStage(
    queue: ImportFollowUpQueue,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    const scheduled = new Promise<boolean>((resolve, reject) => {
      queue.pending.push(async () => {
        if (this.closed) {
          resolve(false);
          return;
        }
        try {
          await operation();
          resolve(true);
        } catch (error: unknown) {
          reject(error);
        }
      });
    });
    this.runFollowUps(queue);
    return scheduled;
  }

  private runFollowUps(queue: ImportFollowUpQueue): void {
    while (this.closed || queue.active < this.maxConcurrentJobs) {
      const start = queue.pending.shift();
      if (start === undefined) return;
      queue.active += 1;
      void start().finally(() => {
        queue.active -= 1;
        this.runFollowUps(queue);
      });
    }
  }

  private async finishFollowUp(job: InternalImportJob): Promise<void> {
    const { revision, documentHash, followUpPending, gameId } = job.snapshot;
    const season = job.sourceSeason;
    if (revision === null || documentHash === null || season === null || followUpPending !== true)
      return;
    let failure: unknown;
    const cleaned = await this.followUpStage(this.fileCleanups, async () => {
      try {
        await this.withGame(gameId, async () => {
          if (job.target?.artifact !== undefined) {
            await this.workspace.removeImportedStaging?.(
              season,
              gameId,
              documentHash,
              job.target.artifact,
            );
          } else if (this.importer.importPublication === undefined) {
            const current = (await this.workspace.catalog()).games.find(
              (game) => game.gameId === gameId,
            );
            if (current?.authority === "staging")
              await this.workspace.removeImportedStaging?.(season, gameId, documentHash);
          }
        });
      } catch (error: unknown) {
        failure = error;
      }
    });
    delete job.cleaningArtifact;
    this.schedule();
    if (!cleaned) return;
    const reevaluated = await this.followUpStage(this.reevaluations, async () => {
      try {
        await this.onSucceeded(gameId, revision, documentHash);
      } catch (error: unknown) {
        failure ??= error;
      }
    });
    if (!reevaluated) return;
    await this.writeState(job, {
      ...job.snapshot,
      followUpPending: failure !== undefined,
      error:
        failure === undefined
          ? null
          : "DB 저장 완료 · 후속 정리 필요: " +
            (failure instanceof Error ? failure.message : "알 수 없는 오류"),
      errorCategory: failure === undefined ? null : "persistence",
    });
  }
  private async readLegacyImportInput(gameId: string) {
    const catalog = await this.workspace.catalog([gameId]);
    const source = catalog.games.find(
      (game) => game.gameId === gameId && game.authority === "staging",
    );
    if (source === undefined || source.season === null) return null;
    const document = await this.workspace.readDocument("staging", source.season, gameId);
    const target =
      this.workspace.readImportTarget === undefined
        ? targetOf(document)
        : await this.workspace.readImportTarget(gameId);
    if (target === null || target.documentHash !== stagingDocumentHash(document))
      throw new ImportSourceNotReadyError("적재 중 보정 작업 사본이 변경되었습니다.");
    return { document, target };
  }

  private withGame<T>(gameId: string, operation: () => Promise<T>): Promise<T> {
    return this.workspace.withGameOperation === undefined
      ? operation()
      : this.workspace.withGameOperation(gameId, operation);
  }
}
function targetOf(document: StagingGameDocumentV2): ImportTarget {
  return {
    gameId: document.metadata.gameId,
    season: document.metadata.season,
    documentHash: stagingDocumentHash(document),
    revision: document.revisionBase.kind === "new_game" ? 1 : document.revisionBase.revision + 1,
  };
}
function batchFingerprint(request: ImportReadyBatchCreateRequest): string {
  return canonicalStringify({ selectionId: request.selectionId ?? null });
}
function jobFingerprint(request: ImportJobCreateRequest): string {
  return canonicalStringify({
    gameId: request.gameId,
    expectedDocumentHash: request.expectedDocumentHash ?? null,
  });
}
function cloneBatch(batch: ImportReadyBatchCreated): ImportReadyBatchCreated {
  return { ...batch, jobs: batch.jobs.map((job) => ({ ...job })) };
}
