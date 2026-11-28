import type { Pool, PoolClient } from "pg";
import { canonicalStringify, type AnalysisScope } from "@kbo/contracts";
import { analysisSourceHash } from "./analysis-scope.js";

/**
 * Only snapshot ownership is shared: each analysis still owns its SQL, grain and hashes.
 * Call release once all required rows are captured, before expensive CPU or cache work.
 * After release, the callback must use only captured inputs and issue no further queries.
 */
export async function withAnalysisSnapshot<T>(
  pool: Pick<Pool, "connect">,
  read: (client: PoolClient, release: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let released = false;
  let completion: Promise<void> | undefined;
  const release = () => {
    completion ??= (async () => {
      await client.query("COMMIT");
      released = true;
      client.release();
    })();
    return completion;
  };
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='30s'");
    const result = await read(client, release);
    await release();
    return result;
  } catch (error) {
    if (!released) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A connection whose transaction could not be cleared must not return to the pool.
        released = true;
        client.release(true);
      }
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

export interface AnalysisReadSnapshot {
  readonly client: PoolClient;
  release(): Promise<void>;
  sourceHash(scope: AnalysisScope): Promise<string>;
}

export function withAnalysisReadSnapshot<T>(
  pool: Pick<Pool, "connect">,
  read: (snapshot: AnalysisReadSnapshot) => Promise<T>,
): Promise<T> {
  return withAnalysisSnapshot(pool, (client, release) => {
    const hashes = new Map<string, Promise<string>>();
    return read({
      client,
      release,
      sourceHash(scope) {
        const key = canonicalStringify(scope);
        const existing = hashes.get(key);
        if (existing !== undefined) return existing;
        const pending = analysisSourceHash(client, scope);
        hashes.set(key, pending);
        return pending;
      },
    });
  });
}

type AnalysisPeriodPair<T> = { first: T; second: T };

/** Keep the later read fresh when the first source's recheck does not cover both periods. */
export async function readAnalysisPeriods<T>(
  pool: Pick<Pool, "connect">,
  first: AnalysisScope,
  second: AnalysisScope,
  read: (
    snapshot: AnalysisReadSnapshot,
    first: AnalysisScope,
    second?: AnalysisScope,
  ) => Promise<AnalysisPeriodPair<T>>,
  referenceScope: (scope: AnalysisScope) => AnalysisScope = (scope) => scope,
): Promise<AnalysisPeriodPair<T>> {
  if (canonicalStringify(first) === canonicalStringify(second))
    return withAnalysisReadSnapshot(pool, (snapshot) => read(snapshot, first));
  if (canonicalStringify(referenceScope(first)) === canonicalStringify(referenceScope(second)))
    return withAnalysisReadSnapshot(pool, (snapshot) => read(snapshot, first, second));
  const a = await withAnalysisReadSnapshot(pool, (snapshot) => read(snapshot, first));
  const b = await withAnalysisReadSnapshot(pool, (snapshot) => read(snapshot, second));
  return { first: a.first, second: b.first };
}
