import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { CollectionDiscoveryRecord } from "@kbo/contracts";
import { CollectionWorkspace } from "@kbo/persistence";

const firstRange = { startDate: "2026-06-01", endDate: "2026-06-30" };
const nextRange = { startDate: "2026-07-01", endDate: "2026-07-31" };

function record(id: string, key: string, range = firstRange): CollectionDiscoveryRecord {
  return {
    idempotencyKey: key,
    discovery: {
      discoveryId: id,
      range,
      status: "failed",
      createdAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:00:01.000Z",
      pageCount: 0,
      gameCount: 0,
      complete: false,
      error: "Cafe\u0301",
    },
  };
}

it("indexes persisted discovery requests by date range and exact key with the original ordering", async () => {
  await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-discovery-index-"));
  let fail = false;
  const workspace = new CollectionWorkspace(temp.path, async () => {
    if (fail) throw new Error("writer lost");
  });
  await workspace.saveDiscovery(record("b", "Cafe\u0301"));
  await workspace.saveDiscovery(record("a", "Cafe\u0301"));
  const reads = vi.spyOn(workspace, "discovery");
  const [list, match] = await Promise.all([
    workspace.discoveriesForRange(firstRange),
    workspace.discoveryForKey("Café"),
  ]);
  expect(list.map(({ discoveryId }) => discoveryId)).toEqual(["a", "b"]);
  expect(match).toMatchObject({ discovery: { discoveryId: "a", error: "Café" } });
  if (match === undefined) throw new Error("Missing indexed discovery");
  match.discovery.error = "changed by a caller";
  expect((await workspace.discoveryForKey("Café"))?.discovery.error).toBe("Café");
  expect(await workspace.discoveryForKey("Cafe\u0301")).toBeUndefined();
  expect(reads).toHaveBeenCalledTimes(2);

  await workspace.saveDiscovery(record("a", "new-key", nextRange));
  expect(
    (await workspace.discoveriesForRange(firstRange)).map(({ discoveryId }) => discoveryId),
  ).toEqual(["b"]);
  expect((await workspace.discoveryForKey("Café"))?.discovery.discoveryId).toBe("b");
  expect((await workspace.discoveryForKey("new-key"))?.discovery.discoveryId).toBe("a");
  expect(reads).toHaveBeenCalledTimes(2);

  fail = true;
  await expect(workspace.saveDiscovery(record("c", "new-key", nextRange))).rejects.toThrow(
    "writer lost",
  );
  expect(
    (await workspace.discoveriesForRange(nextRange)).map(({ discoveryId }) => discoveryId),
  ).toEqual(["a"]);
  expect(reads).toHaveBeenCalledTimes(4);
  const reopened = new CollectionWorkspace(temp.path, async () => undefined);
  expect(await reopened.discoveries()).toEqual(await workspace.discoveries());
});
