import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CollectionWorkspace } from "@kbo/persistence";
import type { CollectionHistoryRecord, CollectionItemResult } from "@kbo/contracts";

function row(gameId: string): CollectionItemResult {
  return {
    gameId,
    gameDate: "2026-04-02",
    label: "비식별 경기",
    outcome: "source_failure",
    message: "응답 없음",
    finishedAt: "2026-09-05T00:00:00.000Z",
  };
}
describe("collection result index", () => {
  it("reads only the selected immutable files after reopening a completed result list", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-result-pages-"));
    const original = new CollectionWorkspace(temp.path, async () => undefined);
    const scope = { kind: "game_ids" as const, gameIds: ["a", "b", "c"] };
    const history: CollectionHistoryRecord = {
      job: {
        jobId: "job",
        kind: "collection",
        scope,
        status: "succeeded",
        createdAt: "2026-09-05T00:00:00.000Z",
        startedAt: "2026-09-05T00:00:00.000Z",
        finishedAt: "2026-09-05T00:00:02.000Z",
        completedItems: 3,
        skippedItems: 0,
        totalItems: 3,
        currentGameId: null,
        summary: { ready: 1, quarantined: 0, sourceFailures: 2 },
        error: null,
        errorCategory: null,
      },
      request: { scope, idempotencyKey: "anonymous-result-pages" },
      sequence: 1,
      range: null,
    };
    const a = { ...row("a"), finishedAt: "2026-09-05T00:00:01.000Z" };
    const b = { ...row("b"), outcome: "ready" as const };
    const c = row("c");
    for (const item of [c, b, a]) await original.saveResult("job", item);
    // The terminal checkpoint is available even if no result list has been opened before.
    await original.saveHistory(history);
    const index = path.join(temp.path, "collection/jobs/job/result-index.json");
    expect(
      JSON.parse(await readFile(index, "utf8")).payload.map(
        (item: { gameId: string }) => item.gameId,
      ),
    ).toEqual(["b", "c", "a"]);

    function observe(workspace: CollectionWorkspace) {
      return vi.spyOn(workspace as unknown as { read(filename: string): Promise<unknown> }, "read");
    }
    function itemReads(read: ReturnType<typeof observe>) {
      return read.mock.calls.filter(([file]) => file.includes(`${path.sep}items${path.sep}`));
    }
    const reopened = new CollectionWorkspace(temp.path, async () => undefined);
    const read = observe(reopened);
    expect(await reopened.resultPage("job", 1, 1, false, "succeeded")).toEqual({
      items: [c],
      total: 3,
    });
    expect(await reopened.resultPage("job", 1, 1, true, "succeeded")).toEqual({
      items: [a],
      total: 2,
    });
    expect(
      await reopened.resultPage("job", Number.POSITIVE_INFINITY, 1, false, "succeeded"),
    ).toEqual({ items: [], total: 3 });
    expect(itemReads(read).map(([file]) => path.basename(file))).toEqual(["c.json", "a.json"]);

    const offPage = path.join(temp.path, "collection/jobs/job/items/b.json");
    const originalResult = await readFile(offPage, "utf8");
    await writeFile(offPage, "corrupt");
    const damaged = new CollectionWorkspace(temp.path, async () => undefined);
    await expect(damaged.resultPage("job", 1, 1, false, "succeeded")).rejects.toThrow();
    await writeFile(offPage, originalResult);

    await writeFile(index, "not an index");
    const fallback = new CollectionWorkspace(temp.path, async () => undefined);
    expect(await fallback.resultPage("job", 0, 3, false, "succeeded")).toEqual({
      items: [b, c, a],
      total: 3,
    });
    const failing = vi
      .spyOn(fallback, "rememberResult")
      .mockRejectedValueOnce(new Error("known-game failed"));
    const d = { ...row("d"), outcome: "interrupted" as const };
    await expect(fallback.saveResult("job", d)).rejects.toThrow("known-game failed");
    expect(failing).toHaveBeenCalledOnce();
    // Membership changed after the older index was written. The primary result file wins.
    const repaired = new CollectionWorkspace(temp.path, async () => undefined);
    expect(await repaired.resultPage("job", 0, 5, true, "succeeded")).toEqual({
      items: [c, d, a],
      total: 3,
    });
  });

  it("reuses validated rows, isolates responses and keeps concurrent appends and failed writes fresh", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-results-"));
    const collection = new CollectionWorkspace(temp.path, async () => undefined);
    await collection.saveResult("job", row("a"));
    const first = await collection.results("job");
    first.splice(0);
    const filename = path.join(temp.path, "collection/jobs/job/items/a.json");
    const stored = await readFile(filename, "utf8");
    await writeFile(filename, "invalid");
    expect(await collection.results("job")).toEqual([row("a")]);
    await writeFile(filename, stored);
    await Promise.all([
      collection.saveResult("job", row("b")),
      collection.saveResult("job", row("c")),
      collection.results("job"),
    ]);
    expect(await collection.results("job")).toEqual([row("a"), row("b"), row("c")]);
    await expect(
      collection.saveResult("job", { ...row("b"), message: "overwrite" }),
    ).rejects.toThrow("덮어쓸");
    expect(await collection.results("job")).toEqual([row("a"), row("b"), row("c")]);
    const restarted = new CollectionWorkspace(temp.path, async () => undefined);
    expect(await restarted.results("job")).toEqual(await collection.results("job"));
  });
});
