import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RegistryWorkspace } from "@kbo/persistence";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("registry source workspace", () => {
  it("원문을 gzip+hash manifest로 저장하고 같은 resume만 허용한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kbo-registry-workspace-"));
    roots.push(root);
    const workspace = new RegistryWorkspace(root, 2024, "run-sanitized");
    const saved = await workspace.savePage({
      pageKind: "register",
      requestKey: "register:2024-04-01:SS",
      body: "<html>비식별 등록 원문</html>",
      collectedAt: "2024-04-01T00:00:00.000Z",
    });
    expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await workspace.readPage("register", "register:2024-04-01:SS");
    expect(loaded).toMatchObject({
      body: "<html>비식별 등록 원문</html>",
      artifactKey: saved.artifactKey,
      contentHash: saved.contentHash,
    });
    expect(
      (await readFile(path.join(root, ...saved.artifactKey.split("/")))).includes(
        Buffer.from("비식별"),
      ),
    ).toBe(false);
    await expect(
      workspace.savePage({
        pageKind: "register",
        requestKey: "register:2024-04-01:SS",
        body: "<html>변경된 원문</html>",
        collectedAt: "2024-04-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/변경/);
  });
});
