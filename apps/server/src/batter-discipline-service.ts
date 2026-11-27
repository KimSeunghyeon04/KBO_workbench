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
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { DisciplineCacheScope, DisciplinePreparedWorkspace } from "@kbo/persistence";
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
  scope: DisciplineCacheScope;
  query: DisciplineQuery;
  batterId: string;
  resolve: (data: DisciplineResponse) => void;
  reject: (error: unknown) => void;
}

interface PreparedCache {
  store: Pick<DisciplinePreparedWorkspace, "read" | "write">;
  sourceHash: (query: DisciplineQuery) => Promise<string>;
  reportError: (error: unknown) => void;
}

const replySchema = Type.Object(
  {
    result: Type.Union([DisciplineResponseSchema, Type.Null()]),
    artifact: Type.Optional(Type.Uint8Array()),
    cacheError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const replyValidator = TypeCompiler.Compile(replySchema);
type WorkerReply = Static<typeof replySchema>;

export class BatterDisciplineService {
  private readonly queue: Job[] = [];
  private readonly pending = new Map<string, Promise<DisciplineResponse>>();
  private worker: Worker | undefined;
  private known: (DisciplineCacheScope & { hash: string }) | undefined;
  private current: Job | undefined;
  private cancel: ((error: Error) => void) | undefined;
  private cacheWrite: Promise<void> | undefined;
  private pendingCacheWrite: { scope: DisciplineCacheScope; artifact: Uint8Array } | undefined;
  private closed = false;
  public constructor(
    private readonly repository: Repository,
    private readonly cache?: PreparedCache,
  ) {}

  public analyze(query: DisciplineQuery, batterId: string): Promise<DisciplineResponse> {
    const { season, competition } = resolveAnalysisScope({
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
      this.queue.push({ scope: { season, competition }, query, batterId, resolve, reject });
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
      const { reply, sourceHash } = (await this.readPrepared(job)) ?? (await this.readSource(job));
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
      if (reply.cacheError !== undefined) this.cache?.reportError(new Error(reply.cacheError));
      if (reply.artifact !== undefined && this.cache !== undefined) {
        this.pendingCacheWrite = { scope: job.scope, artifact: reply.artifact };
        this.startCacheWrite();
      }
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
    const sourceHash = await this.cache.sourceHash(job.query);
    const reply = await this.run(
      { season: job.scope.season, sourceHash, reference: null, rows: null },
      job,
      artifact,
    );
    return reply.result === null ? undefined : { reply, sourceHash };
  }

  private async readSource(job: Job) {
    if (this.closed) throw new Error("Discipline analysis is closed");
    const snapshot = await this.repository.snapshot(
      job.query.season,
      this.isKnownScope(job.scope) ? this.known?.hash : undefined,
      job.query.competition === undefined ? {} : { competition: job.query.competition },
    );
    const reply = await this.run(snapshot, job);
    return { reply, sourceHash: snapshot.sourceHash };
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
        if (!replyValidator.Check(raw)) {
          fail(new Error("Invalid discipline response"));
          return;
        }
        cleanup();
        resolve(raw);
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
            persist: false,
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
              append,
              complete,
              persist: complete && this.cache !== undefined,
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
    while (this.cacheWrite !== undefined) await this.cacheWrite;
    this.known = undefined;
  }
}
