import { createHash, randomUUID } from "node:crypto";

import {
  canonicalStringify,
  compareCanonicalStrings,
  type GameCatalog,
  type GameCatalogItem,
  type ImportJob,
  type ImportJobCreateRequest,
  type ImportReadyBatchCreated,
  type ImportReadyBatchCreateRequest,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import {
  BlockingImportError,
  DatabaseContractError,
  GameAlreadyImportedError,
  PersistenceIntegrityError,
  RevisionConflictError,
  type GameRevisionStore,
  type ImportedRevision,
} from "@kbo/persistence";

interface ImportWorkspace {
  catalog(): Promise<GameCatalog>;
  readDocument(
    authority: "staging" | "quarantine",
    season: number,
    gameId: string,
  ): Promise<StagingGameDocumentV2>;
  removeImportedStaging?(
    season: number,
    gameId: string,
    expectedDocumentHash: string,
  ): Promise<void>;
}

interface RevisionImporter {
  catalog(): Promise<readonly GameCatalogItem[]>;
  importRevision(
    input: unknown,
    options?: object,
    originalInput?: unknown,
  ): Promise<ImportedRevision>;
}

interface InternalImportJob {
  readonly request: ImportJobCreateRequest;
  readonly sourceSeason: number | null;
  snapshot: ImportJob;
  execution: Promise<void> | null;
}

export class ImportJobNotFoundError extends Error {}
export class ImportIdempotencyConflictError extends Error {}
export class ImportSourceNotReadyError extends Error {}

export class ImportJobManager {
  private readonly jobs = new Map<string, InternalImportJob>();
  private readonly pendingJobIds: string[] = [];
  private readonly idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly jobId: string }
  >();
  private readonly batchCreations = new Map<string, Promise<ImportReadyBatchCreated>>();
  private runningJobs = 0;
  private closed = false;

  public constructor(
    private readonly workspace: ImportWorkspace,
    private readonly importer: Pick<GameRevisionStore, "importRevision"> | RevisionImporter,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly maxConcurrentJobs = 2,
    private readonly onSucceeded: (
      gameId: string,
      revision: number,
      documentHash: string,
    ) => Promise<void> = async () => undefined,
  ) {
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1) {
      throw new Error("동시 적재 작업 수는 1 이상의 정수여야 합니다.");
    }
  }

  public create(request: ImportJobCreateRequest): ImportJob {
    return this.createWithSource(request, null);
  }

  private createWithSource(
    request: ImportJobCreateRequest,
    sourceSeason: number | null,
  ): ImportJob {
    if (this.closed) throw new Error("종료 중에는 적재 작업을 만들 수 없습니다.");
    const fingerprint = canonicalStringify({ gameId: request.gameId });
    const existing = this.idempotency.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new ImportIdempotencyConflictError(
          "같은 idempotency key에 다른 경기가 지정되었습니다.",
        );
      }
      return this.get(existing.jobId);
    }
    const jobId = this.newId();
    const snapshot: ImportJob = {
      jobId,
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
    };
    const job: InternalImportJob = { request, sourceSeason, snapshot, execution: null };
    this.jobs.set(jobId, job);
    this.idempotency.set(request.idempotencyKey, { fingerprint, jobId });
    this.pendingJobIds.push(jobId);
    queueMicrotask(() => this.schedule());
    return cloneImportJob(snapshot);
  }

  public async createReadyBatch(
    request: ImportReadyBatchCreateRequest,
  ): Promise<ImportReadyBatchCreated> {
    if (this.closed) throw new Error("종료 중에는 일괄 적재 작업을 만들 수 없습니다.");
    const existing = this.batchCreations.get(request.idempotencyKey);
    if (existing !== undefined) return cloneImportReadyBatch(await existing);
    const creation = this.buildReadyBatch(request);
    this.batchCreations.set(request.idempotencyKey, creation);
    try {
      return cloneImportReadyBatch(await creation);
    } catch (error: unknown) {
      if (this.batchCreations.get(request.idempotencyKey) === creation)
        this.batchCreations.delete(request.idempotencyKey);
      throw error;
    }
  }

  public get(jobId: string): ImportJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new ImportJobNotFoundError("적재 작업을 찾을 수 없습니다.");
    return cloneImportJob(job.snapshot);
  }

  public list(): readonly ImportJob[] {
    return [...this.jobs.values()]
      .map((job) => cloneImportJob(job.snapshot))
      .sort((left, right) => compareCanonicalStrings(right.createdAt, left.createdAt));
  }

  public async waitForTerminal(jobId: string): Promise<ImportJob> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new ImportJobNotFoundError("적재 작업을 찾을 수 없습니다.");
    while (job.execution === null) await new Promise<void>((resolve) => setImmediate(resolve));
    await job.execution;
    return cloneImportJob(job.snapshot);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.schedule();
    await Promise.allSettled([...this.jobs.keys()].map((jobId) => this.waitForTerminal(jobId)));
  }

  private async buildReadyBatch(
    request: ImportReadyBatchCreateRequest,
  ): Promise<ImportReadyBatchCreated> {
    const workspaceCatalog = await this.workspace.catalog();
    const activeGameIds = new Set(
      [...this.jobs.values()]
        .filter((job) => !isTerminal(job.snapshot.status))
        .map((job) => job.snapshot.gameId),
    );
    const ready = workspaceCatalog.games
      .filter((game) => game.authority === "staging")
      .sort((left, right) => compareCanonicalStrings(left.gameId, right.gameId));
    const candidates = ready.filter(
      (game) => game.season !== null && !activeGameIds.has(game.gameId),
    );
    const batchId = this.newId();
    const jobs = candidates.map((game) => {
      const job = this.createWithSource(
        {
          gameId: game.gameId,
          idempotencyKey: batchChildIdempotencyKey(request.idempotencyKey, game.gameId),
        },
        game.season,
      );
      return { jobId: job.jobId, gameId: job.gameId, status: job.status };
    });
    return {
      batchId,
      createdCount: jobs.length,
      skippedCount: ready.length - candidates.length,
      jobs,
    };
  }

  private schedule(): void {
    while (this.runningJobs < this.maxConcurrentJobs) {
      const jobId = this.pendingJobIds.shift();
      if (jobId === undefined) return;
      const job = this.jobs.get(jobId);
      if (job === undefined || job.execution !== null) continue;
      this.runningJobs += 1;
      job.execution = this.run(job).finally(() => {
        this.runningJobs -= 1;
        this.schedule();
      });
    }
  }

  private async run(job: InternalImportJob): Promise<void> {
    job.snapshot = {
      ...job.snapshot,
      status: "running",
      startedAt: this.now().toISOString(),
    };
    try {
      const sourceSeason = job.sourceSeason ?? (await this.findReadySeason(job.request.gameId));
      const document = await this.workspace.readDocument(
        "staging",
        sourceSeason,
        job.request.gameId,
      );
      const imported = await this.importer.importRevision(document);
      await this.workspace.removeImportedStaging?.(
        sourceSeason,
        job.request.gameId,
        imported.documentHash,
      );
      await this.onSucceeded(job.request.gameId, imported.revision, imported.documentHash).catch(
        () => undefined,
      );
      job.snapshot = {
        ...job.snapshot,
        status: "succeeded",
        finishedAt: this.now().toISOString(),
        revision: imported.revision,
        documentHash: imported.documentHash,
        projectionHash: imported.projectionHash,
      };
    } catch (error: unknown) {
      job.snapshot = {
        ...job.snapshot,
        status: "failed",
        finishedAt: this.now().toISOString(),
        error: error instanceof Error ? error.message : "알 수 없는 적재 오류",
        errorCategory: importErrorCategory(error),
      };
    }
  }

  private async findReadySeason(gameId: string): Promise<number> {
    const catalog = await this.workspace.catalog();
    const item = catalog.games.find(
      (candidate) => candidate.gameId === gameId && candidate.authority === "staging",
    );
    if (item === undefined || item.season === null) {
      throw new ImportSourceNotReadyError(
        `staging ready 상태인 경기를 찾을 수 없습니다: ${gameId}`,
      );
    }
    return item.season;
  }
}

function cloneImportJob(job: ImportJob): ImportJob {
  return { ...job };
}

function cloneImportReadyBatch(batch: ImportReadyBatchCreated): ImportReadyBatchCreated {
  return { ...batch, jobs: batch.jobs.map((job) => ({ ...job })) };
}

function batchChildIdempotencyKey(batchKey: string, gameId: string): string {
  return createHash("sha256").update(`${batchKey}:${gameId}`).digest("hex");
}

function isTerminal(status: ImportJob["status"]): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}

function importErrorCategory(error: unknown): "domain" | "persistence" {
  if (
    error instanceof ImportSourceNotReadyError ||
    error instanceof BlockingImportError ||
    error instanceof GameAlreadyImportedError ||
    error instanceof RevisionConflictError
  ) {
    return "domain";
  }
  if (error instanceof DatabaseContractError || error instanceof PersistenceIntegrityError) {
    return "persistence";
  }
  return "persistence";
}
