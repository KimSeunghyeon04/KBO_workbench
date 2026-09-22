import { randomUUID } from "node:crypto";
import type { AnalysisModelJob } from "@kbo/contracts";
import { modelTrainingPeriod } from "@kbo/game-core";
import type { AnalysisModelJobWorkspace } from "@kbo/persistence";
import {
  MODEL_ORDER,
  ModelSourceChangedError,
  type AnalysisModelService,
} from "../analysis-model-service.js";
export class AnalysisModelJobConflictError extends Error {}
export class AnalysisModelJobNotFoundError extends Error {}
export class AnalysisModelJobManager {
  private latest: AnalysisModelJob | null = null;
  private enabledSeasons: number[] = [];
  private closed = false;
  private active: { controller: AbortController; promise: Promise<void> } | null = null;
  private barrier: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  public constructor(
    private readonly store: Pick<
      AnalysisModelJobWorkspace,
      "latest" | "get" | "save" | "policy" | "setPolicy"
    >,
    private readonly service: Pick<AnalysisModelService, "status" | "refresh">,
    private readonly now = () => new Date(),
    private readonly uuid = randomUUID,
    private readonly reportError: (error: unknown) => void = () => {},
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.barrier.then(operation);
    this.barrier = next.catch(() => {});
    return next;
  }
  public async start() {
    this.latest = await this.store.latest();
    this.enabledSeasons = (await this.store.policy()).enabledSeasons;
    if (this.latest?.state === "running") {
      const job = structuredClone(this.latest);
      job.state = "failed";
      job.error = "서비스가 재시작되어 미완료 작업을 중단했습니다. 완료 모델은 유지됩니다.";
      for (const step of job.steps)
        if (step.state === "running" || step.state === "pending") step.state = "cancelled";
      await this.commit(job);
    }
    this.schedule();
  }
  private async commit(job: AnalysisModelJob) {
    job.sequence++;
    job.updatedAt = this.now().toISOString();
    await this.store.save(job);
    this.latest = structuredClone(job);
  }
  public async status(applicationSeason = 2025) {
    return {
      models: await this.service.status(applicationSeason),
      latestJob: structuredClone(this.latest),
      policy: { version: 2 as const, enabledSeasons: [...this.enabledSeasons] },
      checkIntervalHours: 6 as const,
    };
  }
  public async get(id: string) {
    const job = this.latest?.id === id ? structuredClone(this.latest) : await this.store.get(id);
    if (job === null) throw new AnalysisModelJobNotFoundError("모델 갱신 작업이 없습니다.");
    return job;
  }
  public async create(
    requestId: string,
    force: boolean,
    applicationSeason = 2025,
    trigger: "manual" | "automatic" = "manual",
  ) {
    return this.serial(async () => {
      if (this.closed) throw new AnalysisModelJobConflictError("서비스가 종료 중입니다.");
      if (modelTrainingPeriod("re24", applicationSeason).support !== "eligible")
        throw new AnalysisModelJobConflictError(
          "학습과 두 검증 시즌이 확보되는 2023–2025 시즌만 갱신할 수 있습니다.",
        );
      if (trigger === "automatic" && !this.enabledSeasons.includes(applicationSeason))
        throw new AnalysisModelJobConflictError("자동 갱신이 꺼져 있습니다.");
      const existing =
        this.latest?.id === requestId
          ? structuredClone(this.latest)
          : await this.store.get(requestId);
      if (existing !== null) {
        if (
          existing.force !== force ||
          existing.trigger !== trigger ||
          existing.applicationSeason !== applicationSeason
        )
          throw new AnalysisModelJobConflictError("같은 요청 ID의 갱신 조건이 다릅니다.");
        return existing;
      }
      if (this.active !== null)
        throw new AnalysisModelJobConflictError("다른 모델 갱신 작업이 실행 중입니다.");
      const time = this.now().toISOString();
      const job: AnalysisModelJob = {
        version: 2,
        applicationSeason,
        id: requestId,
        force,
        trigger,
        sequence: 0,
        state: "running",
        createdAt: time,
        updatedAt: time,
        error: null,
        steps: MODEL_ORDER.map((kind) => ({
          kind,
          state: "pending",
          phase: "waiting",
          modelHash: null,
        })),
      };
      await this.commit(job);
      const controller = new AbortController();
      // Dispatch after the creation snapshot is durable; all heavy work belongs to the worker.
      const promise = Promise.resolve()
        .then(() => this.run(job, controller.signal))
        .finally(() => {
          this.active = null;
        });
      this.active = { controller, promise };
      return structuredClone(job);
    });
  }
  private async run(job: AnalysisModelJob, signal: AbortSignal) {
    try {
      for (const step of job.steps) {
        signal.throwIfAborted();
        // Re-read after the preceding publication: matchup depends on the quality artifact hash.
        const status = (await this.service.status(job.applicationSeason)).find(
          (model) => model.kind === step.kind,
        );
        signal.throwIfAborted();
        if (status?.state === "unsupported") {
          step.state = "unsupported";
          step.phase = "done";
        } else if (!job.force && status?.state === "current") {
          step.state = "skipped";
          step.phase = "done";
          step.modelHash = status.modelHash;
        } else {
          step.state = "running";
          step.phase = "reading";
          await this.commit(job);
          step.modelHash = await this.service.refresh(
            step.kind,
            signal,
            async (phase) => {
              signal.throwIfAborted();
              step.phase = phase;
              await this.commit(job);
            },
            job.applicationSeason,
          );
          step.state = "published";
          step.phase = "done";
        }
        await this.commit(job);
      }
      job.state = "succeeded";
    } catch (error) {
      if (!signal.aborted) this.reportError(error);
      job.state = signal.aborted ? "cancelled" : "failed";
      job.error = signal.aborted
        ? "사용자 요청 또는 서비스 종료로 중단했습니다. 완료 모델은 유지됩니다."
        : error instanceof ModelSourceChangedError
          ? error.message
          : "모델 갱신에 실패했습니다. 원천·메모리·DB 연결과 서버 로그를 확인해 주세요.";
      for (const step of job.steps) {
        if (step.state === "running") step.state = signal.aborted ? "cancelled" : "failed";
        else if (step.state === "pending") step.state = "cancelled";
      }
    }
    // A failed journal write must leave a visible failed state and a recoverable durable snapshot.
    try {
      await this.commit(job);
    } catch {
      this.latest = {
        ...structuredClone(job),
        state: "failed",
        error: "작업 상태 저장에 실패했습니다. 저장 공간과 writer 상태를 확인해 주세요.",
      };
    }
  }
  public async cancel(id: string) {
    return this.serial(async () => {
      const job = await this.get(id);
      if (this.latest?.id === id) this.active?.controller.abort();
      return job;
    });
  }
  public async setPolicy(enabled: boolean, applicationSeason = 2025) {
    return this.serial(async () => {
      if (this.closed) throw new AnalysisModelJobConflictError("서비스가 종료 중입니다.");
      const policy = await this.store.setPolicy(applicationSeason, enabled);
      this.enabledSeasons = policy.enabledSeasons;
      this.schedule(enabled ? 0 : undefined);
      return policy;
    });
  }
  private schedule(delay = 6 * 60 * 60_000) {
    clearTimeout(this.timer);
    if (this.enabledSeasons.length === 0 || this.closed) return;
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }
  public async check() {
    if (this.closed || this.enabledSeasons.length === 0 || this.active !== null) return;
    for (const season of [...this.enabledSeasons]) {
      if (this.closed || !this.enabledSeasons.includes(season)) continue;
      let changed = true;
      try {
        changed = (await this.service.status(season)).some(
          (model) => model.state === "missing" || model.state === "stale",
        );
      } catch {
        // Source-check errors use the same durable failure path, once per scheduled check.
      }
      if (!changed) continue;
      try {
        await this.create(this.uuid(), false, season, "automatic");
        await this.waitForActive();
        if (this.latest?.state === "cancelled") return;
      } catch {
        return; /* Closing, disabled policy or competing manual job. */
      }
    }
  }
  private async waitForActive() {
    await this.active?.promise;
  }
  public async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.barrier;
    this.active?.controller.abort();
    await this.active?.promise;
  }
}
