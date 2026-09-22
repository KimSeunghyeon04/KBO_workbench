import type { CoverageInspection } from "@kbo/persistence";
import type { AnalysisCoveragePreparation } from "@kbo/contracts";
import { ComputationBusyError } from "../computation-pool.js";

interface Task {
  inspection: CoverageInspection;
  state: AnalysisCoveragePreparation["state"];
}

/** Demand-driven, disposable preparation; one season in memory, at most 16 queued scopes. */
export class AnalysisCoverageJobManager {
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private readonly abort = new AbortController();
  private active: Promise<void> | undefined;
  public constructor(
    private readonly prepare: (
      inspection: CoverageInspection,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly reportFailure: (error: unknown) => void,
  ) {}

  public ensure(inspection: CoverageInspection, retry = false): AnalysisCoveragePreparation {
    if (this.abort.signal.aborted)
      throw new ComputationBusyError("품질 요약 서비스가 종료 중입니다.");
    const { sourceKey, scope } = inspection;
    const existing = this.tasks.get(sourceKey);
    if (existing !== undefined && !(existing.state === "failed" && retry))
      return { sourceKey, scope, state: existing.state };
    if (this.queue.length >= 16)
      throw new ComputationBusyError("품질 요약 요청이 많습니다. 잠시 뒤 다시 시도하세요.");
    // Failed entries carry no raw inputs and remain bounded; a new source always has its own task.
    if (this.tasks.size >= 32) {
      for (const [key, task] of this.tasks) {
        if (task.state === "failed") {
          this.tasks.delete(key);
          break;
        }
      }
    }
    const task: Task = { inspection, state: "preparing" };
    this.tasks.set(sourceKey, task);
    this.queue.push(task);
    this.pump();
    return { sourceKey, scope, state: "preparing" };
  }

  public async close(): Promise<void> {
    this.abort.abort();
    this.queue.length = 0;
    await this.active;
    this.tasks.clear();
  }

  private pump(): void {
    if (this.active !== undefined || this.abort.signal.aborted) return;
    const task = this.queue.shift();
    if (task === undefined) return;
    this.active = Promise.resolve()
      .then(() => this.prepare(task.inspection, this.abort.signal))
      .then(() => {
        this.tasks.delete(task.inspection.sourceKey);
      })
      .catch((error: unknown) => {
        task.state = "failed";
        if (!this.abort.signal.aborted) this.reportFailure(error);
      })
      .finally(() => {
        this.active = undefined;
        this.pump();
      });
  }
}
