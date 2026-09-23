import type { Pool, PoolClient } from "pg";

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
