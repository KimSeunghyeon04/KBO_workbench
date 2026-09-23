import { Client, Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAnalysisSnapshot } from "../../packages/persistence/src/analysis-snapshot.js";

const begin = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
const timeout = "SET LOCAL statement_timeout='30s'";

function connection(failures = new Map<string, Error>()) {
  const release = vi.fn();
  const client = Object.assign(new Client(), { release });
  const pool = new Pool();
  const connect = vi.spyOn(pool, "connect").mockResolvedValue(client);
  const statements: string[] = [];
  vi.spyOn(client, "query").mockImplementation(async (query) => {
    if (typeof query !== "string") throw new Error("Unexpected query configuration");
    statements.push(query);
    const failure = failures.get(query);
    if (failure !== undefined) throw failure;
    return { rows: [], command: "", rowCount: 0, fields: [], oid: 0 };
  });
  return { pool, client, connect, release, statements };
}

afterEach(() => vi.restoreAllMocks());

describe("analysis snapshot ownership", () => {
  it("uses one read-only snapshot for manifest and facts, then releases once", async () => {
    const db = connection();
    const result = await withAnalysisSnapshot(db.pool, async (client) => {
      expect(client).toBe(db.client);
      await client.query("SELECT manifest");
      await client.query("SELECT facts");
      return { sourceHash: "source", rows: [] };
    });
    expect(result).toEqual({ sourceHash: "source", rows: [] });
    expect(db.statements).toEqual([begin, timeout, "SELECT manifest", "SELECT facts", "COMMIT"]);
    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("releases before computation and makes repeated early release harmless", async () => {
    const db = connection();
    await withAnalysisSnapshot(db.pool, async (client, release) => {
      await client.query("SELECT facts");
      await Promise.all([release(), release()]);
      expect(db.release).toHaveBeenCalledOnce();
      await release();
      return "calculated after release";
    });
    expect(db.statements).toEqual([begin, timeout, "SELECT facts", "COMMIT"]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("does not roll back or release again when computation fails after early release", async () => {
    const db = connection();
    const failure = new Error("calculation failed");
    await expect(
      withAnalysisSnapshot(db.pool, async (_client, release) => {
        await release();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(db.statements).toEqual([begin, timeout, "COMMIT"]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("rolls back cancellation without replacing the abort reason", async () => {
    const db = connection();
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    await expect(
      withAnalysisSnapshot(db.pool, async (client) => {
        await client.query("SELECT facts");
        controller.abort(reason);
        controller.signal.throwIfAborted();
      }),
    ).rejects.toBe(reason);
    expect(db.statements).toEqual([begin, timeout, "SELECT facts", "ROLLBACK"]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([begin, timeout, "SELECT facts", "COMMIT"])(
    "rolls back and releases when %s fails",
    async (statement) => {
      const failure = new Error(`${statement} failed`);
      const db = connection(new Map([[statement, failure]]));
      await expect(
        withAnalysisSnapshot(db.pool, async (client) => client.query("SELECT facts")),
      ).rejects.toBe(failure);
      expect(db.statements.at(-1)).toBe("ROLLBACK");
      expect(db.release).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("discards a connection when rollback fails and preserves the original error", async () => {
    const failure = new Error("original query error");
    const db = connection(
      new Map([
        ["SELECT facts", failure],
        ["ROLLBACK", new Error("lost connection")],
      ]),
    );
    await expect(
      withAnalysisSnapshot(db.pool, async (client) => client.query("SELECT facts")),
    ).rejects.toBe(failure);
    expect(db.statements).toEqual([begin, timeout, "SELECT facts", "ROLLBACK"]);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not enter the callback if acquiring a connection fails", async () => {
    const db = connection();
    const failure = new Error("pool unavailable");
    db.connect.mockRejectedValueOnce(failure);
    const read = vi.fn();
    await expect(withAnalysisSnapshot(db.pool, read)).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
    expect(db.statements).toEqual([]);
    expect(db.release).not.toHaveBeenCalled();
  });
});
