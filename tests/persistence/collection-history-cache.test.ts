import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CollectionWorkspace } from "@kbo/persistence";
import type { CollectionHistoryRecord } from "@kbo/contracts";

function history(jobId: string): CollectionHistoryRecord {
  const scope = { kind: "game_ids" as const, gameIds: ["anonymous"] };
  return {
    job: {
      jobId,
      kind: "collection",
      scope,
      status: "succeeded",
      createdAt: "2026-09-13T00:00:00Z",
      startedAt: null,
      finishedAt: "2026-09-13T00:00:01Z",
      completedItems: 1,
      skippedItems: 0,
      totalItems: 1,
      currentGameId: null,
      summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
      error: null,
      errorCategory: null,
    },
    request: { scope, idempotencyKey: `anonymous-${jobId}` },
    sequence: 1,
    range: null,
  };
}

describe("bounded collection history pages", () => {
  it("reuses verified pages, isolates mutations, and invalidates concurrent/failed writes", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-history-"));
    let fail = false;
    const collection = new CollectionWorkspace(temp.path, async () => {
      if (fail) throw new Error("writer lost");
    });
    await collection.saveHistory(history("b"));
    await collection.saveHistory(history("a"));
    const page = await collection.historyPage(0, 1);
    expect(page.total).toBe(2);
    expect(page.records[0]?.job.jobId).toBe("a");
    page.records.splice(0);
    const filename = path.join(temp.path, "collection/jobs/a/record.json");
    const stored = await readFile(filename, "utf8");
    await writeFile(filename, "corrupt");
    expect((await collection.historyPage(0, 1)).records).toEqual([history("a")]);
    await writeFile(filename, stored);
    await Promise.all([
      collection.saveHistory(history("c")),
      collection.saveHistory(history("d")),
      collection.historyPage(0, 2),
    ]);
    expect((await collection.historyPage(2, 2)).records.map((r) => r.job.jobId)).toEqual([
      "c",
      "d",
    ]);
    fail = true;
    await expect(collection.saveHistory(history("e"))).rejects.toThrow("writer lost");
    expect((await collection.historyPage(0, 2)).total).toBe(4);
    const restarted = new CollectionWorkspace(temp.path, async () => undefined);
    expect(await restarted.histories()).toEqual(await collection.histories());
    await writeFile(filename, "corrupt");
    await expect(
      new CollectionWorkspace(temp.path, async () => undefined).historyPage(0, 2),
    ).rejects.toThrow();
  });
});
