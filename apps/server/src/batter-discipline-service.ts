import { Worker } from "node:worker_threads";
import {
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
  DisciplineResponseSchema,
  type DisciplineQuery,
  type DisciplineResponse,
  type DisciplineSnapshot,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { PitchAnalysisBusyError } from "./pitch-clustering-workers.js";
import { sendWorkerRows } from "./worker-row-transport.js";

interface Repository {
  snapshot(
    season: number,
    knownHash?: string,
    options?: AnalysisScopeOptions,
  ): Promise<DisciplineSnapshot>;
}
interface Job {
  query: DisciplineQuery;
  batterId: string;
  resolve: (data: DisciplineResponse) => void;
  reject: (error: unknown) => void;
}

export class BatterDisciplineService {
  private readonly queue: Job[] = [];
  private readonly pending = new Map<string, Promise<DisciplineResponse>>();
  private worker: Worker | undefined;
  private known: { season: number; hash: string } | undefined;
  private current: Job | undefined;
  private cancel: ((error: Error) => void) | undefined;
  private closed = false;
  public constructor(private readonly repository: Repository) {}

  public analyze(query: DisciplineQuery, batterId: string): Promise<DisciplineResponse> {
    resolveAnalysisScope({
      season: query.season,
      ...(query.competition === undefined ? {} : { competition: query.competition }),
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
    });
    if (this.closed) return Promise.reject(new Error("Discipline analysis is closed"));
    const key = canonicalStringify([query, batterId]);
    const running = this.pending.get(key);
    if (running !== undefined) return running;
    if (this.queue.length >= 16)
      return Promise.reject(
        new PitchAnalysisBusyError("선구안 분석 요청이 많습니다. 잠시 뒤 다시 시도해 주세요."),
      );
    const result = new Promise<DisciplineResponse>((resolve, reject) => {
      this.queue.push({ query, batterId, resolve, reject });
      void this.pump();
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }

  private async pump(): Promise<void> {
    if (this.current !== undefined || this.closed) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.current = job;
    try {
      const snapshot = await this.repository.snapshot(
        job.query.season,
        this.known?.season === job.query.season ? this.known.hash : undefined,
        job.query.competition === undefined ? {} : { competition: job.query.competition },
      );
      if (this.closed) throw new Error("Discipline analysis is closed");
      const result = await this.run(snapshot, job);
      if (
        result.query.season !== job.query.season ||
        result.batterId !== job.batterId ||
        result.sourceHash !== snapshot.sourceHash ||
        canonicalStringify(result.query) !== canonicalStringify(job.query)
      )
        throw new Error("Discipline worker response mismatch");
      this.known = { season: snapshot.season, hash: snapshot.sourceHash };
      job.resolve(result);
    } catch (error: unknown) {
      this.known = undefined;
      const worker = this.worker;
      this.worker = undefined;
      if (worker !== undefined) await worker.terminate();
      job.reject(error);
    } finally {
      this.current = undefined;
      void this.pump();
    }
  }

  private run(snapshot: DisciplineSnapshot, job: Job): Promise<DisciplineResponse> {
    if (this.worker === undefined) {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      this.worker = new Worker(new URL(`./batter-discipline-worker.${extension}`, import.meta.url));
      const worker = this.worker;
      worker.on("error", (error) => {
        this.known = undefined;
        this.cancel?.(error);
      });
      worker.on("exit", () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.known = undefined;
          this.cancel?.(new Error("Discipline worker stopped"));
        }
      });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        finished = true;
        clearTimeout(timer);
        worker.off("message", message);
        this.cancel = undefined;
      };
      const fail = (error: Error) => {
        if (finished) return;
        cleanup();
        reject(error);
      };
      const message = (raw: unknown) => {
        try {
          const result = Value.Decode(DisciplineResponseSchema, raw);
          cleanup();
          resolve(result);
        } catch {
          fail(new Error("Invalid discipline response"));
        }
      };
      const timer = setTimeout(
        () => fail(new Error("Discipline analysis exceeded 60 seconds")),
        60_000,
      );
      this.cancel = fail;
      worker.once("message", message);
      const send = async () => {
        const rows = snapshot.rows;
        if (rows === null) {
          worker.postMessage({
            snapshot,
            query: job.query,
            batterId: job.batterId,
            append: false,
            complete: true,
          });
          return;
        }
        await sendWorkerRows(
          rows,
          ({ rows, append, complete }) =>
            worker.postMessage({
              snapshot: { ...snapshot, rows },
              query: job.query,
              batterId: job.batterId,
              append,
              complete,
            }),
          () => !finished,
        );
      };
      void send().catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error("Cannot send discipline request")),
      );
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Discipline analysis is closed");
    for (const job of this.queue.splice(0)) job.reject(error);
    this.current?.reject(error);
    this.cancel?.(error);
    if (this.worker !== undefined) await this.worker.terminate();
    this.known = undefined;
  }
}
