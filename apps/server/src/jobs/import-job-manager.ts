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

interface ImportSourceWorkspace {
  readonly imports?: ImportWorkspace;
  withGameOperation?<T>(gameId: string, operation: () => Promise<T>): Promise<T>;
  catalog(): Promise<GameCatalog>;
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
  execution: Promise<void> | null;
  publicationPending?: true;
}
export class ImportJobNotFoundError extends Error {}
export class ImportIdempotencyConflictError extends Error {}
export class ImportSourceNotReadyError extends Error {}

export class ImportJobManager {
  private readonly jobs = new Map<string, InternalImportJob>();
  private readonly retainedJobs = new Map<string, ImportJob>();
  private orderedIds: readonly string[] | undefined;
  private readonly pendingJobIds: string[] = [];
  private readonly idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  private readonly batches = new Map<
    string,
    { fingerprint: string; result: ImportReadyBatchCreated }
  >();
  private readonly selections = new Map<string, ImportSelectionRecord>();
  private creationTail: Promise<unknown> = Promise.resolve();
  private runningJobs = 0;
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

  public async restore(): Promise<void> {
    const storage = this.workspace.imports;
    if (storage === undefined) return;
    this.orderedIds = undefined;
    for (const job of await storage.retainedJobs()) this.retainedJobs.set(job.jobId, job);
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
      await this.restoreJob(job);
    }
  }

  private async restoreJob(job: InternalImportJob): Promise<void> {
    await this.withGame(job.snapshot.gameId, async () => {
      if (
        job.snapshot.status === "succeeded" &&
        job.snapshot.revision !== null &&
        job.snapshot.documentHash !== null
      ) {
        await this.followUpUnlocked(job);
        await this.save(job);
        return;
      }
      let committed: ImportedRevision | null;
      try {
        committed = await this.committedPublication(job);
      } catch {
        this.keepPublicationPending(job);
        await this.save(job);
        return;
      }
      if (committed !== null) {
        this.recordPublication(job, committed);
        await this.save(job);
        await this.followUpUnlocked(job);
      } else {
        delete job.publicationPending;
        job.snapshot = {
          ...job.snapshot,
          status: "cancelled",
          interrupted: true,
          finishedAt: this.now().toISOString(),
          error: "봉인 기록이 확인되지 않은 중단 작업입니다. 현재 상태를 확인해 다시 선택하세요.",
          errorCategory: "persistence",
        };
      }
      await this.save(job);
    });
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

  private keepPublicationPending(job: InternalImportJob): void {
    job.publicationPending = true;
    job.snapshot = {
      ...job.snapshot,
      status: "running",
      finishedAt: null,
      error: "DB 봉인 결과를 아직 확인하지 못했습니다. 복구 시 다시 확인합니다.",
      errorCategory: "persistence",
    };
  }

  private recordPublication(job: InternalImportJob, imported: ImportedRevision): void {
    delete job.publicationPending;
    job.snapshot = {
      ...job.snapshot,
      status: "succeeded",
      finishedAt: job.snapshot.finishedAt ?? this.now().toISOString(),
      revision: imported.revision,
      documentHash: imported.documentHash,
      projectionHash: imported.projectionHash,
      followUpPending: true,
      error: null,
      errorCategory: null,
    };
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
      const target = await this.workspace.readImportTarget?.(request.gameId);
      const job = this.prepare(request, target ?? null);
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
    const catalog = await this.workspace.catalog();
    const included = criteria.gameIds === undefined ? null : new Set(criteria.gameIds);
    const excluded = new Set(criteria.excludedGameIds ?? []);
    const search = (criteria.search ?? "").trim().toLocaleLowerCase("ko-KR");
    const active = new Set(
      this.list()
        .filter(
          (job) => !isTerminal(job.status) || (job.followUpPending === true && job.error === null),
        )
        .map((job) => job.gameId),
    );
    const candidates = catalog.games
      .filter(
        (game) =>
          game.authority === "staging" &&
          (criteria.season === undefined || game.season === criteria.season) &&
          (included === null || included.has(game.gameId)) &&
          !excluded.has(game.gameId) &&
          !active.has(game.gameId) &&
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
      const active = new Set(
        this.list()
          .filter(
            (job) =>
              !isTerminal(job.status) || (job.followUpPending === true && job.error === null),
          )
          .map((job) => job.gameId),
      );
      const jobs = selected.targets
        .filter((target) => !active.has(target.gameId))
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
    return this.orderedJobs().map((job) => ({ ...job }));
  }
  private orderedJobs(): ImportJob[] {
    if (this.orderedIds === undefined) {
      this.orderedIds = [
        ...[...this.retainedJobs.values()].filter((job) => !this.jobs.has(job.jobId)),
        ...[...this.jobs.values()].map((job) => job.snapshot),
      ]
        .sort(
          (a, b) =>
            compareCanonicalStrings(b.createdAt, a.createdAt) ||
            compareCanonicalStrings(a.jobId, b.jobId),
        )
        .map((job) => job.jobId);
    }
    const ordered: ImportJob[] = [];
    for (const id of this.orderedIds) {
      const job = this.jobs.get(id)?.snapshot ?? this.retainedJobs.get(id);
      if (job !== undefined) ordered.push(job);
    }
    return ordered;
  }
  public history(query: ImportHistoryQuery): ImportHistory {
    const scope = this.orderedJobs().filter(
      (job) => query.batchId === undefined || job.batchId === query.batchId,
    );
    const search = (query.search ?? "").trim().toLocaleLowerCase("ko-KR");
    const filtered = scope.filter(
      (job) =>
        (query.status === undefined || job.status === query.status) &&
        (search === "" ||
          `${job.gameId} ${job.jobId} ${job.error ?? ""}`
            .toLocaleLowerCase("ko-KR")
            .includes(search)),
    );
    const page = query.page ?? 1,
      limit = query.limit ?? 50;
    const summary = {
      total: scope.length,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of scope) if (job.status !== "cancelling") summary[job.status] += 1;
    return {
      jobs: filtered.slice((page - 1) * limit, page * limit).map((job) => ({ ...job })),
      activeJobs: scope
        .filter(
          (job) => job.status === "running" || (job.followUpPending === true && job.error === null),
        )
        .slice(0, 200)
        .map((job) => ({ ...job })),
      total: filtered.length,
      page,
      limit,
      summary,
    };
  }
  public async cancel(jobId: string): Promise<ImportJob> {
    const job = this.internal(jobId);
    if (job.snapshot.status === "queued") {
      job.snapshot = {
        ...job.snapshot,
        status: "cancelled",
        finishedAt: this.now().toISOString(),
        error: "대기 중 취소했습니다.",
        errorCategory: null,
      };
      await this.save(job);
    }
    return this.get(jobId);
  }
  public async cancelBatch(batchId: string): Promise<void> {
    const pending = [...this.jobs.values()].filter(
      (job) => job.snapshot.batchId === batchId && job.snapshot.status === "queued",
    );
    for (const job of pending)
      job.snapshot = {
        ...job.snapshot,
        status: "cancelled",
        finishedAt: this.now().toISOString(),
        error: "대기 중 취소했습니다.",
        errorCategory: null,
      };
    for (const job of pending) await this.save(job);
  }
  public async reconcile(jobId: string): Promise<ImportJob> {
    const job = this.internal(jobId);
    if (job.publicationPending === true) {
      await this.restoreJob(job);
    } else if (job.snapshot.status === "succeeded" && job.snapshot.followUpPending === true) {
      await this.followUp(job);
      await this.save(job);
    }
    return this.get(jobId);
  }
  public async waitForTerminal(jobId: string): Promise<ImportJob> {
    const job = this.internal(jobId);
    while (!isTerminal(job.snapshot.status) && job.execution === null)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await job.execution;
    return this.get(jobId);
  }
  public async close(): Promise<void> {
    this.closed = true;
    await this.creationTail;
    for (const job of this.jobs.values()) await this.cancel(job.snapshot.jobId);
    await Promise.allSettled(
      [...this.jobs.values()].flatMap((job) => (job.execution === null ? [] : [job.execution])),
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
    this.orderedIds = undefined;
    this.jobs.set(record.job.jobId, {
      request: record.request,
      sourceSeason: record.sourceSeason,
      target: record.target,
      snapshot: record.job,
      ...(record.publicationPending ? { publicationPending: true as const } : {}),
      execution: null,
    });
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
  private schedule(): void {
    if (this.closed) return;
    while (this.runningJobs < this.maxConcurrentJobs) {
      const id = this.pendingJobIds.shift();
      if (id === undefined) return;
      const job = this.jobs.get(id);
      if (job === undefined || job.execution !== null || job.snapshot.status !== "queued") continue;
      this.runningJobs += 1;
      job.execution = this.run(job)
        .catch((error: unknown) => {
          // 기록 장치가 실패하면 새 적재를 시작하지 않는다. 다음 시작에서 저장된 의도와 DB를 대조한다.
          this.closed = true;
          job.snapshot = {
            ...job.snapshot,
            status: job.snapshot.revision === null ? "failed" : "succeeded",
            finishedAt: job.snapshot.finishedAt ?? this.now().toISOString(),
            error: `적재 이력 저장 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
            errorCategory: "persistence",
          };
          for (const pending of this.jobs.values()) {
            if (pending.snapshot.status !== "queued") continue;
            pending.snapshot = {
              ...pending.snapshot,
              status: "cancelled",
              interrupted: true,
              finishedAt: this.now().toISOString(),
              error: "이력 저장 장치 오류로 실행하지 않았습니다. 서버 복구 후 다시 선택하세요.",
              errorCategory: "persistence",
            };
          }
        })
        .finally(() => {
          this.runningJobs -= 1;
          this.schedule();
        });
    }
  }
  private async run(job: InternalImportJob): Promise<void> {
    job.snapshot = { ...job.snapshot, status: "running", startedAt: this.now().toISOString() };
    try {
      await this.save(job);
      await this.withGame(job.snapshot.gameId, async () => {
        if (job.target === null && this.workspace.readImportTarget !== undefined)
          throw new ImportSourceNotReadyError("접수 시 적재 가능 작업본이 없었습니다.");
        const catalog = await this.workspace.catalog();
        const source = catalog.games.find(
          (game) => game.gameId === job.snapshot.gameId && game.authority === "staging",
        );
        if (source?.season === null || source === undefined)
          throw new ImportSourceNotReadyError("staging ready 상태인 경기를 찾을 수 없습니다.");
        const document = await this.workspace.readDocument("staging", source.season, source.gameId);
        const target =
          this.workspace.readImportTarget === undefined
            ? targetOf(document)
            : await this.workspace.readImportTarget(source.gameId);
        if (target === null || target.documentHash !== stagingDocumentHash(document))
          throw new ImportSourceNotReadyError("적재 중 보정 작업 사본이 변경되었습니다.");
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
        job.sourceSeason = source.season;
        const verifiedMatchupGeneration = await this.verifyRecordCorrection?.(document, target);
        const publication = this.importer.importPublication !== undefined;
        if (publication && target.artifact === undefined)
          throw new ImportSourceNotReadyError("저장된 작업본의 적재 식별자가 없습니다.");
        if (publication) job.publicationPending = true;
        await this.save(job);
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
        this.recordPublication(job, imported);
        await this.save(job);
        await this.followUpUnlocked(job);
      });
    } catch (error: unknown) {
      if (job.publicationPending === true) {
        let committed: ImportedRevision | null;
        try {
          committed = await this.committedPublication(job);
        } catch {
          this.keepPublicationPending(job);
          await this.save(job);
          return;
        }
        if (committed !== null) {
          this.recordPublication(job, committed);
          await this.save(job);
          await this.followUp(job);
          await this.save(job);
          return;
        }
        delete job.publicationPending;
      }
      job.snapshot = {
        ...job.snapshot,
        status:
          job.snapshot.revision !== null
            ? "succeeded"
            : error instanceof ImportSourceNotReadyError && job.target !== null
              ? "cancelled"
              : "failed",
        finishedAt: this.now().toISOString(),
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
    await this.save(job);
  }
  private async followUp(job: InternalImportJob): Promise<void> {
    await this.withGame(job.snapshot.gameId, () => this.followUpUnlocked(job));
  }
  private async followUpUnlocked(job: InternalImportJob): Promise<void> {
    const { revision, documentHash } = job.snapshot;
    if (revision === null || documentHash === null || job.sourceSeason === null) return;
    try {
      let cleanup: unknown;
      try {
        if (job.target?.artifact !== undefined) {
          await this.workspace.removeImportedStaging?.(
            job.sourceSeason,
            job.snapshot.gameId,
            documentHash,
            job.target.artifact,
          );
        } else if (this.importer.importPublication === undefined) {
          const current = (await this.workspace.catalog()).games.find(
            (game) => game.gameId === job.snapshot.gameId,
          );
          if (current?.authority === "staging")
            await this.workspace.removeImportedStaging?.(
              job.sourceSeason,
              job.snapshot.gameId,
              documentHash,
            );
        }
      } catch (error: unknown) {
        cleanup = error;
      }
      await this.onSucceeded(job.snapshot.gameId, revision, documentHash);
      if (cleanup !== undefined) throw cleanup;
      job.snapshot = { ...job.snapshot, followUpPending: false, error: null, errorCategory: null };
    } catch (error: unknown) {
      job.snapshot = {
        ...job.snapshot,
        followUpPending: true,
        error: `DB 저장 완료 · 후속 정리 필요: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
        errorCategory: "persistence",
      };
    }
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
function isTerminal(status: ImportJob["status"]): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}
