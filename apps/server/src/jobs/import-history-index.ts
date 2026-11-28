import {
  compareCanonicalStrings,
  type ImportHistory,
  type ImportHistoryQuery,
  type ImportJob,
} from "@kbo/contracts";

function followUp(job: ImportJob): boolean {
  return job.followUpPending === true && job.error === null;
}

function compareJobs(a: ImportJob, b: ImportJob): number {
  return (
    compareCanonicalStrings(b.createdAt, a.createdAt) || compareCanonicalStrings(a.jobId, b.jobId)
  );
}

const emptySummary: ImportHistory["summary"] = {
  total: 0,
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
};

export function isTerminal(status: ImportJob["status"]): boolean {
  return status === "cancelled" || status === "succeeded" || status === "failed";
}

class HistoryBucket {
  public readonly jobs = new Map<string, ImportJob>();
  public readonly active = new Map<string, ImportJob>();
  public readonly summary = { ...emptySummary };
  private orderedIds: string[] | undefined;

  public set(job: ImportJob): void {
    const previous = this.jobs.get(job.jobId);
    if (previous === undefined || previous.createdAt !== job.createdAt) this.orderedIds = undefined;
    if (previous === undefined) this.summary.total += 1;
    else if (previous.status !== "cancelling") this.summary[previous.status] -= 1;
    if (job.status !== "cancelling") this.summary[job.status] += 1;
    this.jobs.set(job.jobId, job);
    if (job.status === "running" || followUp(job)) this.active.set(job.jobId, job);
    else this.active.delete(job.jobId);
  }

  public delete(job: ImportJob): void {
    if (!this.jobs.delete(job.jobId)) return;
    this.orderedIds = undefined;
    this.active.delete(job.jobId);
    this.summary.total -= 1;
    if (job.status !== "cancelling") this.summary[job.status] -= 1;
  }

  public order(): readonly string[] {
    return (this.orderedIds ??= [...this.jobs.values()]
      .sort(compareJobs)
      .map(({ jobId }) => jobId));
  }
}

export class ImportHistoryIndex {
  private readonly all = new HistoryBucket();
  private readonly batches = new Map<string, HistoryBucket>();

  public upsert(job: ImportJob): void {
    const previous = this.all.jobs.get(job.jobId);
    if (previous?.batchId !== undefined && previous.batchId !== job.batchId) {
      const oldBatch = this.batches.get(previous.batchId);
      oldBatch?.delete(previous);
      if (oldBatch?.jobs.size === 0) this.batches.delete(previous.batchId);
    }
    this.all.set(job);
    if (job.batchId !== undefined) {
      const batch = this.batches.get(job.batchId) ?? new HistoryBucket();
      batch.set(job);
      this.batches.set(job.batchId, batch);
    }
  }

  public list(): ImportJob[] {
    return this.all.order().flatMap((id) => {
      const job = this.all.jobs.get(id);
      return job === undefined ? [] : [{ ...job }];
    });
  }

  public read(query: ImportHistoryQuery): ImportHistory {
    const bucket = query.batchId === undefined ? this.all : this.batches.get(query.batchId);
    const page = query.page ?? 1,
      limit = query.limit ?? 50;
    if (bucket === undefined)
      return {
        jobs: [],
        activeJobs: [],
        page,
        limit,
        total: 0,
        summary: { ...emptySummary },
      };
    const search = (query.search ?? "").trim().toLocaleLowerCase("ko-KR");
    const order = bucket.order();
    const matching =
      search === "" && query.status === undefined
        ? order
        : order.filter((id) => {
            const job = bucket.jobs.get(id);
            return (
              job !== undefined &&
              (query.status === undefined || job.status === query.status) &&
              (search === "" ||
                `${job.gameId} ${job.jobId} ${job.error ?? ""}`
                  .toLocaleLowerCase("ko-KR")
                  .includes(search))
            );
          });
    const start = (page - 1) * limit;
    const jobs = matching.slice(start, start + limit).flatMap((id) => {
      const job = bucket.jobs.get(id);
      return job === undefined ||
        (query.view === "activity" && isTerminal(job.status) && !followUp(job))
        ? []
        : [{ ...job }];
    });
    const activeJobs = [...bucket.active.values()]
      .sort(compareJobs)
      .slice(0, 200)
      .map((job) => ({ ...job }));
    return {
      jobs,
      activeJobs,
      total: matching.length,
      page,
      limit,
      summary: { ...bucket.summary },
    };
  }
}
