import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CollectionWorkspace } from "@kbo/persistence";
import type { CollectionItemResult } from "@kbo/contracts";

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
