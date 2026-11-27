import { Worker } from "node:worker_threads";
import {
  canonicalStringify,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
  DisciplineResponseSchema,
  DisciplinePeriodInputSchema,
  type DisciplineQuery,
  type DisciplineResponse,
  type DisciplinePeriodInput,
  type DisciplineSnapshot,
} from "@kbo/contracts";
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { DisciplineCacheScope, DisciplinePreparedWorkspace } from "@kbo/persistence";
import { PitchAnalysisBusyError } from "./pitch-clustering-workers.js";
import { sendWorkerRows } from "./worker-row-transport.js";
import { disciplineCacheSourceHash } from "./batter-discipline-cache-header.js";

interface Repository {
  snapshot(
    season: number,
    knownHash?: string,
    options?: AnalysisScopeOptions,
  ): Promise<DisciplineSnapshot>;
}
type AnalysisResult = DisciplineResponse | DisciplinePeriodInput;

interface Job {
  scope: DisciplineCacheScope;
  query: DisciplineQuery;
  batterId: string;
  mode: "full" | "period";
  resolve: (data: AnalysisResult) => void;
  reject: (error: unknown) => void;
}

interface PreparedCache {
  store: Pick<DisciplinePreparedWorkspace, "read" | "write">;
  sourceHash: (query: DisciplineQuery) => Promise<string>;
  reportError: (error: unknown) => void;
}

const replySchema = Type.Object(
  { result: Type.Union([DisciplineResponseSchema, DisciplinePeriodInputSchema, Type.Null()]) },
  { additionalProperties: false },
);
const replyValidator = TypeCompiler.Compile(replySchema);
type WorkerReply = Static<typeof replySchema>;
const cacheReplyValidator = TypeCompiler.Compile(
  Type.Object(
    {
      artifact: Type.Optional(Type.Uint8Array()),
      cacheError: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

export class BatterDisciplineService {
  private readonly queue: Job[] = [];
  private readonly pending = new Map<string, Promise<DisciplineResponse>>();
  private readonly pendingPeriods = new Map<string, Promise<DisciplinePeriodInput>>();
  private worker: Worker | undefined;
  private known: (DisciplineCacheScope & { hash: string }) | undefined;
  private current: Job | undefined;
  private cancel: ((error: Error) => void) | undefined;
  private cacheEncoding: Promise<void> | undefined;
  private cacheWrite: Promise<void> | undefined;
  private pendingCacheWrite: { scope: DisciplineCacheScope; artifact: Uint8Array } | undefined;
  private closed = false;
  public constructor(
    private readonly repository: Repository,
    private readonly cache?: PreparedCache,
  ) {}

  public analyze(query: DisciplineQuery, batterId: string): Promise<DisciplineResponse> {
    return this.enqueue(query, batterId, "full", this.pending, (data) => "points" in data);
  }

  public analyzePeriod(query: DisciplineQuery, batterId: string): Promise<DisciplinePeriodInput> {
    return this.enqueue(
      query,
      batterId,
      "period",
      this.pendingPeriods,
      (data) => "mapSwings" in data,
    );
  }

  private enqueue<Result extends AnalysisResult>(
    query: DisciplineQuery,
    batterId: string,
    mode: Job["mode"],
    pending: Map<string, Promise<Result>>,
    accepts: (data: AnalysisResult) => data is Result,
  ): Promise<Result> {
    const { season, competition } = resolveAnalysisScope({
      season: query.season,
      ...(query.competition === undefined ? {} : { competition: query.competition }),
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
    });
    if (this.closed) return Promise.reject(new Error("Discipline analysis is closed"));
    const key = canonicalStringify([query, batterId]);
    const running = pending.get(key);
    if (running !== undefined) return running;
    if (this.queue.length >= 16)
      return Promise.reject(
        new PitchAnalysisBusyError("선구안 분석 요청이 많습니다. 잠시 뒤 다시 시도해 주세요."),
      );
    const result = new Promise<Result>((resolve, reject) => {
      this.queue.push({
        scope: { season, competition },
        query,
        batterId,
        mode,
        reject,
        resolve: (data) => {
          if (!accepts(data)) throw new Error("Discipline worker sent the wrong result type");
          resolve(data);
        },
      });
      void this.pump();
    }).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  }

  private async pump(): Promise<void> {
    if (this.current !== undefined || this.closed) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    this.current = job;
    try {
      const { reply, sourceHash, preparedFromRows } =
        (await this.readPrepared(job)) ?? (await this.readSource(job));
      if (this.closed) throw new Error("Discipline analysis is closed");
      const { result } = reply;
      if (
        result === null ||
        result.query.season !== job.query.season ||
        result.batterId !== job.batterId ||
        result.sourceHash !== sourceHash ||
        canonicalStringify(result.query) !== canonicalStringify(job.query)
      )
        throw new Error("Discipline worker response mismatch");
      this.known = { ...job.scope, hash: sourceHash };
      job.resolve(result);
      if (preparedFromRows && this.cache !== undefined) {
        // Keep the prepared rows in this worker until its cache reply arrives.
        this.cacheEncoding = this.prepareCache(job.scope, this.cache);
        try {
          await this.cacheEncoding;
        } finally {
          this.cacheEncoding = undefined;
        }
      }
    } catch (error: unknown) {
      await this.resetWorker();
      job.reject(error);
    } finally {
      this.current = undefined;
      void this.pump();
    }
  }

  private async prepareCache(scope: DisciplineCacheScope, cache: PreparedCache): Promise<void> {
    let reply;
    try {
      reply = await this.requestWorker(
        (raw) => cacheReplyValidator.Check(raw),
        (worker) => worker.postMessage("encode-cache"),
        "Discipline cache encoding exceeded 60 seconds",
      );
    } catch (error: unknown) {
      await this.resetWorker();
      cache.reportError(error);
      return;
    }
    if (reply.cacheError !== undefined) cache.reportError(new Error(reply.cacheError));
    if (reply.artifact !== undefined) {
      this.pendingCacheWrite = { scope, artifact: reply.artifact };
      this.startCacheWrite();
    }
  }

  private startCacheWrite(): void {
    const cache = this.cache;
    const pending = this.pendingCacheWrite;
    if (cache === undefined || pending === undefined || this.cacheWrite !== undefined) return;
    // A slow disk can retain only the active artifact and the most recent pending one.
    this.pendingCacheWrite = undefined;
    this.cacheWrite = Promise.resolve()
      .then(() => cache.store.write(pending.scope, pending.artifact))
      .catch(cache.reportError)
      .finally(() => {
        this.cacheWrite = undefined;
        this.startCacheWrite();
      });
  }

  private isKnownScope({ season, competition }: DisciplineCacheScope): boolean {
    return this.known?.season === season && this.known.competition === competition;
  }

  private async readPrepared(job: Job) {
    if (this.cache === undefined || this.isKnownScope(job.scope)) return undefined;
    const artifact = await this.cache.store.read(job.scope).catch((error: unknown) => {
      this.cache?.reportError(error);
      return undefined;
    });
    if (artifact === undefined) return undefined;
    if (this.closed) throw new Error("Discipline analysis is closed");
    this.getWorker();
    const storedHash = disciplineCacheSourceHash(artifact);
    if (storedHash !== undefined) {
      const snapshot = await this.readSnapshot(job, storedHash);
      if (snapshot.rows !== null) return this.analyzeSnapshot(snapshot, job);
      return this.restorePrepared(snapshot, job, artifact);
    }
    const sourceHash = await this.cache.sourceHash(job.query);
    return this.restorePrepared(
      { season: job.scope.season, sourceHash, reference: null, rows: null },
      job,
      artifact,
    );
  }

  private async restorePrepared(snapshot: DisciplineSnapshot, job: Job, artifact: Uint8Array) {
    const reply = await this.run(snapshot, job, artifact);
    return reply.result === null
      ? undefined
      : { reply, sourceHash: snapshot.sourceHash, preparedFromRows: false };
  }

  private async readSource(job: Job) {
    return this.analyzeSnapshot(
      await this.readSnapshot(job, this.isKnownScope(job.scope) ? this.known?.hash : undefined),
      job,
    );
  }

  private readSnapshot(job: Job, knownHash: string | undefined) {
    if (this.closed) throw new Error("Discipline analysis is closed");
    return this.repository.snapshot(
      job.query.season,
      knownHash,
      job.query.competition === undefined ? {} : { competition: job.query.competition },
    );
  }

  private async analyzeSnapshot(snapshot: DisciplineSnapshot, job: Job) {
    const reply = await this.run(snapshot, job);
    return { reply, sourceHash: snapshot.sourceHash, preparedFromRows: snapshot.rows !== null };
  }

  private getWorker(): Worker {
    if (this.closed) throw new Error("Discipline analysis is closed");
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
    return this.worker;
  }

  private run(snapshot: DisciplineSnapshot, job: Job, artifact?: Uint8Array): Promise<WorkerReply> {
    return this.requestWorker(
      (raw) => replyValidator.Check(raw),
      async (worker, isActive) => {
        const rows = snapshot.rows;
        if (rows === null) {
          worker.postMessage({
            snapshot,
            query: job.query,
            batterId: job.batterId,
            mode: job.mode,
            append: false,
            complete: true,
            ...(artifact === undefined ? {} : { artifact }),
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
              mode: job.mode,
              append,
              complete,
            }),
          isActive,
        );
      },
      "Discipline analysis exceeded 60 seconds",
    );
  }

  private requestWorker<Reply>(
    validate: (raw: unknown) => raw is Reply,
    send: (worker: Worker, isActive: () => boolean) => void | Promise<void>,
    timeoutMessage: string,
  ): Promise<Reply> {
    const worker = this.getWorker();
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
        if (!validate(raw)) {
          fail(new Error("Invalid discipline response"));
          return;
        }
        cleanup();
        resolve(raw);
      };
      const timer = setTimeout(() => fail(new Error(timeoutMessage)), 60_000);
      this.cancel = fail;
      worker.once("message", message);
      void Promise.resolve()
        .then(() => {
          if (!finished) return send(worker, () => !finished);
        })
        .catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error("Cannot send discipline request")),
        );
    });
  }

  private async resetWorker(): Promise<void> {
    this.known = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker !== undefined) await worker.terminate();
  }

  public async close(): Promise<void> {
    this.closed = true;
    const error = new Error("Discipline analysis is closed");
    for (const job of this.queue.splice(0)) job.reject(error);
    this.current?.reject(error);
    if (this.cacheEncoding === undefined) this.cancel?.(error);
    else await this.cacheEncoding;
    await this.resetWorker();
    while (this.cacheWrite !== undefined) await this.cacheWrite;
  }
}
