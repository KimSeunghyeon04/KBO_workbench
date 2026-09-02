import { randomUUID } from "node:crypto";

import type {
  RecordCorrectionJob,
  RecordCorrectionJobCreateRequest,
  RecordCorrectionJobCreated,
} from "@kbo/contracts";
import type { KboRecordCorrectionCollector } from "@kbo/collection";
import { RecordCorrectionRepository, RecordCorrectionWorkspace } from "@kbo/persistence";

import type { RecordCorrectionService } from "../record-correction-service.js";

export class RecordCorrectionJobNotFoundError extends Error {}
export class RecordCorrectionJobConflictError extends Error {}

export interface RecordCorrectionScheduleOptions {
  readonly enabled: boolean;
  readonly syncIntervalMs: number;
  readonly retryIntervalMs: number;
}

export class RecordCorrectionJobManager {
  private readonly executions = new Map<
    string,
    { readonly controller: AbortController; readonly execution: Promise<void> }
  >();
  private readonly activeSeasons = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledAt: Date | null = null;
  private closed = false;

  public constructor(
    private readonly collector: KboRecordCorrectionCollector,
    private readonly repository: RecordCorrectionRepository,
    private readonly service: RecordCorrectionService,
    private readonly workspaceRoot: string,
    private readonly scheduleOptions: RecordCorrectionScheduleOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  public async start(): Promise<void> {
    if (this.closed) return;
    for (const resumable of await this.repository.resumableJobs())
      this.launch(resumable.jobId, resumable.seasons, resumable.hasChanges);
    if (!this.scheduleOptions.enabled) return;
    const summary = await this.repository.summary(null);
    const last = summary.lastSuccessfulAt === null ? null : new Date(summary.lastSuccessfulAt);
    const due =
      last === null ? this.now() : new Date(last.getTime() + this.scheduleOptions.syncIntervalMs);
    this.schedule(due);
  }

  public nextScheduledAt(): string | null {
    return this.scheduledAt?.toISOString() ?? null;
  }

  public async create(
    request: RecordCorrectionJobCreateRequest,
    trigger: "manual" | "scheduled" = "manual",
  ): Promise<RecordCorrectionJobCreated> {
    if (this.closed) throw new Error("종료 중에는 기록정정 동기화를 시작할 수 없습니다.");
    const seasons = [...(request.seasons ?? (await this.repository.seasonsWithSealedGames()))].sort(
      (left, right) => left - right,
    );
    if (seasons.length === 0) throw new RecordCorrectionJobConflictError("sealed 경기가 없습니다.");
    if (seasons.some((season) => this.activeSeasons.has(season)))
      throw new RecordCorrectionJobConflictError("같은 시즌의 기록정정 동기화가 실행 중입니다.");
    const jobId = this.newId();
    const created = await this.repository.createJob(
      jobId,
      trigger,
      request.idempotencyKey,
      seasons,
      this.now().toISOString(),
    );
    if (!created.created) return { jobId: created.job.jobId, status: created.job.status };
    this.launch(jobId, seasons);
    return { jobId, status: "queued" };
  }

  public async get(jobId: string): Promise<RecordCorrectionJob> {
    try {
      return await this.repository.job(jobId);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("job이 없습니다"))
        throw new RecordCorrectionJobNotFoundError(error.message);
      throw error;
    }
  }

  public async list(): Promise<readonly RecordCorrectionJob[]> {
    return this.repository.jobs();
  }

  public async cancel(jobId: string): Promise<void> {
    const active = this.executions.get(jobId);
    if (active === undefined) {
      const job = await this.get(jobId);
      if (["cancelled", "succeeded", "failed", "no_change"].includes(job.status)) return;
      throw new RecordCorrectionJobConflictError("실행 중인 기록정정 job이 아닙니다.");
    }
    await this.repository.setJobCancelling(jobId);
    active.controller.abort(new Error("사용자가 기록정정 동기화를 취소했습니다."));
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = null;
    for (const active of this.executions.values()) active.controller.abort();
    await Promise.allSettled([...this.executions.values()].map((active) => active.execution));
  }

  private async run(
    jobId: string,
    seasons: readonly number[],
    signal: AbortSignal,
    hadChanges = false,
  ): Promise<void> {
    await this.repository.setJobRunning(jobId, this.now().toISOString());
    let allNoChange = !hadChanges;
    try {
      for (const season of seasons) {
        if (signal.aborted) throw signal.reason;
        await this.repository.markSeasonRunning(jobId, season);
        const workspace = new RecordCorrectionWorkspace(this.workspaceRoot, season, jobId);
        const result = await this.collector.collect({
          season,
          signal,
          cache: (pageKind, requestKey) => workspace.readPage(pageKind, requestKey),
          sink: async (page) =>
            workspace.savePage({
              pageKind: page.pageKind,
              requestKey: page.requestKey,
              body: page.body,
              collectedAt: page.collectedAt,
            }),
        });
        const imported = await this.repository.importSeason(
          jobId,
          result.dataset,
          result.sourceBundleHash,
        );
        allNoChange &&= imported.noChange;
        if (!imported.noChange || (await this.repository.seasonHasPendingAssessments(season)))
          await this.service.assessSeason(season);
      }
      await this.repository.finishJob(
        jobId,
        allNoChange ? "no_change" : "succeeded",
        this.now().toISOString(),
      );
      if (this.scheduleOptions.enabled)
        this.schedule(new Date(this.now().getTime() + this.scheduleOptions.syncIntervalMs));
    } catch (error: unknown) {
      const cancelled = signal.aborted;
      const job = await this.repository.job(jobId);
      const currentSeason = job.seasons[job.completedSeasons];
      if (currentSeason !== undefined) await this.repository.markSeasonFailed(jobId, currentSeason);
      await this.repository.finishJob(
        jobId,
        cancelled ? "cancelled" : "failed",
        this.now().toISOString(),
        cancelled ? null : "source",
        cancelled ? null : error instanceof Error ? error.message : "기록정정 수집 오류",
      );
      if (!cancelled && this.scheduleOptions.enabled)
        this.schedule(new Date(this.now().getTime() + this.scheduleOptions.retryIntervalMs));
    }
  }

  private launch(jobId: string, seasons: readonly number[], hadChanges = false): void {
    if (seasons.some((season) => this.activeSeasons.has(season)))
      throw new RecordCorrectionJobConflictError("같은 시즌의 기록정정 동기화가 실행 중입니다.");
    const controller = new AbortController();
    seasons.forEach((season) => this.activeSeasons.add(season));
    const execution = this.run(jobId, seasons, controller.signal, hadChanges).finally(() => {
      seasons.forEach((season) => this.activeSeasons.delete(season));
      this.executions.delete(jobId);
    });
    this.executions.set(jobId, { controller, execution });
  }

  private schedule(at: Date): void {
    if (this.closed || !this.scheduleOptions.enabled) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.scheduledAt = at;
    const waitMs = Math.max(0, Math.min(2_147_483_647, at.getTime() - this.now().getTime()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledAt = null;
      void this.create(
        { idempotencyKey: `scheduled-record-correction-${this.now().toISOString()}` },
        "scheduled",
      ).catch(() => {
        this.schedule(new Date(this.now().getTime() + this.scheduleOptions.retryIntervalMs));
      });
    }, waitMs);
  }
}
