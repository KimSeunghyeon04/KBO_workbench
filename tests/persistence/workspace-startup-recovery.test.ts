import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapNaverGame } from "@kbo/collection";
import { canonicalStringify, parseCurrentWorkspaceEntry } from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace } from "@kbo/persistence";
import { sanitizedNaverBundle } from "../helpers/naver.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), rename: vi.fn(actual.rename) };
});

afterEach(() => vi.clearAllMocks());

describe("workspace startup recovery", () => {
  it("uses one temporary directory for original, source, active, current and journal writes", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-location-"));
    const workspace = await StagingWorkspace.open(temp.path);
    try {
      const bundle = await sanitizedNaverBundle();
      const { document } = mapNaverGame(bundle);
      const gameId = document.metadata.gameId;
      const payloads = { preview: { status: "final" } };
      await workspace.saveSourceBundle({
        gameId,
        season: document.metadata.season,
        collectedAt: document.source.collectedAt,
        payloads,
        missingEndpoints: [],
        sourceBundleHash: createHash("sha256")
          .update(canonicalStringify({ gameId, missingEndpoints: [], payloads }))
          .digest("hex"),
      });
      await workspace.saveReady(document, []);
      const moves = vi.mocked(rename).mock.calls.filter(([from]) => String(from).endsWith(".tmp"));
      expect(moves.length).toBeGreaterThanOrEqual(5);
      for (const [from] of moves) {
        expect(path.dirname(String(from))).toBe(path.join(temp.path, ".temporary"));
      }
      expect(
        (await readdir(path.join(temp.path, ".temporary"))).filter((f) => f.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await workspace.close();
    }
  });

  it("cleans old temporary files once and subsequently reads only the temporary directory", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-upgrade-"));
    for (const folder of [
      "source/2026/game",
      "original/2026",
      "superseded/game",
      "collection/jobs",
      "analysis/jobs",
    ]) {
      const directory = path.join(temp.path, folder);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, ".interrupted.tmp"), "partial");
      await writeFile(path.join(directory, "evidence.json"), "preserved");
    }
    const first = await StagingWorkspace.open(temp.path);
    await first.close();
    for (const folder of [
      "source/2026/game",
      "original/2026",
      "superseded/game",
      "collection/jobs",
      "analysis/jobs",
    ]) {
      expect(await readdir(path.join(temp.path, folder))).toEqual(["evidence.json"]);
    }
    await writeFile(path.join(temp.path, ".temporary", ".interrupted.tmp"), "partial");
    vi.mocked(readdir).mockClear();
    const second = await StagingWorkspace.open(temp.path);
    try {
      const directories = vi.mocked(readdir).mock.calls.map(([directory]) => String(directory));
      for (const name of ["source", "original", "superseded", "collection", "analysis"]) {
        expect(
          directories.some(
            (directory) =>
              directory === path.join(temp.path, name) ||
              directory.startsWith(`${path.join(temp.path, name)}${path.sep}`),
          ),
        ).toBe(false);
      }
      expect(await readdir(path.join(temp.path, ".temporary"))).toEqual([
        "legacy-cleanup-complete",
      ]);
      expect(await readFile(path.join(temp.path, "source/2026/game/evidence.json"), "utf8")).toBe(
        "preserved",
      );
    } finally {
      await second.close();
    }
  });

  it("does not mark interrupted legacy cleanup complete and retries it on the next open", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-retry-"));
    const source = path.join(temp.path, "source");
    await mkdir(source);
    await writeFile(path.join(source, ".partial.tmp"), "partial");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const mock = vi.mocked(readdir);
    mock.mockImplementation((...args) => {
      if (String(args[0]) === source) return Promise.reject(new Error("directory unavailable"));
      return actual.readdir(...args);
    });
    try {
      await expect(StagingWorkspace.open(temp.path)).rejects.toThrow("directory unavailable");
    } finally {
      mock.mockImplementation(actual.readdir);
    }
    await expect(
      readFile(path.join(temp.path, ".temporary", "legacy-cleanup-complete")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = await StagingWorkspace.open(temp.path);
    await reopened.close();
    expect(await readdir(source)).toEqual([]);
  });

  it("removes empty active game directories and preserves nonempty directories", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-empty-active-"));
    await mkdir(path.join(temp.path, "active", "empty-game"), { recursive: true });
    const retained = path.join(temp.path, "active", "retained-game");
    await mkdir(retained);
    await writeFile(path.join(retained, "notes.txt"), "preserved");
    const workspace = await StagingWorkspace.open(temp.path);
    try {
      expect(await readdir(path.join(temp.path, "active"))).toEqual(["retained-game"]);
      expect(await readFile(path.join(retained, "notes.txt"), "utf8")).toBe("preserved");
    } finally {
      await workspace.close();
    }
  });

  it.each(["analysis", "source/linked"])(
    "preserves external files when legacy cleanup encounters a linked directory at %s",
    async (relativeLink) => {
      await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-legacy-link-"));
      const root = path.join(temp.path, "workspace");
      const outside = path.join(temp.path, "outside");
      const link = path.join(root, relativeLink);
      const evidence = path.join(outside, ".in-flight.tmp");
      await mkdir(path.dirname(link), { recursive: true });
      await mkdir(outside);
      await writeFile(evidence, "preserved");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

      const workspace = await StagingWorkspace.open(root);
      try {
        await expect(readFile(evidence, "utf8")).resolves.toBe("preserved");
        await expect(
          readFile(path.join(root, ".temporary", "legacy-cleanup-complete"), "utf8"),
        ).resolves.toBe("");
      } finally {
        await workspace.close();
      }
    },
  );

  it("rejects a linked temporary directory without touching files outside the workspace", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-link-"));
    const root = path.join(temp.path, "workspace");
    const outside = path.join(temp.path, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "evidence.tmp"), "preserved");
    await symlink(outside, path.join(root, ".temporary"), "junction");
    await expect(StagingWorkspace.open(root)).rejects.toThrow("실제 디렉터리");
    expect(await readFile(path.join(outside, "evidence.tmp"), "utf8")).toBe("preserved");
  });

  it("rejects an invalid legacy cleanup marker", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-marker-"));
    await mkdir(path.join(temp.path, ".temporary"));
    await writeFile(path.join(temp.path, ".temporary", "legacy-cleanup-complete"), "invalid");
    await expect(StagingWorkspace.open(temp.path)).rejects.toThrow("완료 표식");
  });

  it("keeps current unchanged after a failed atomic rename and recovers the pending temporary file", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-temporary-rename-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const gameId = "20260820RENAME";
    const manifest = path.join(temp.path, "current", `${gameId}.json`);
    try {
      await workspace.saveSourceFailure(gameId, [], 2026);
      const before = await readFile(manifest, "utf8");
      vi.mocked(rename).mockRejectedValueOnce(
        Object.assign(new Error("cross-device rename"), { code: "EXDEV" }),
      );
      await expect(workspace.saveSourceFailure(gameId, [], 2026)).rejects.toMatchObject({
        code: "EXDEV",
      });
      expect(await readFile(manifest, "utf8")).toBe(before);
      expect(
        (await readdir(path.join(temp.path, ".temporary"))).filter((name) => name.endsWith(".tmp")),
      ).toHaveLength(1);
    } finally {
      await workspace.close();
    }
    const reopened = await StagingWorkspace.open(temp.path);
    try {
      expect((await reopened.catalog()).games).toHaveLength(1);
      expect(await readdir(path.join(temp.path, ".temporary"))).toEqual([
        "legacy-cleanup-complete",
      ]);
    } finally {
      await reopened.close();
    }
  });

  it.each([false, true])(
    "cleans the imported game's empty directory without removing retained files: %s",
    async (retainedFile) => {
      await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-empty-active-"));
      const workspace = await StagingWorkspace.open(temp.path);
      try {
        const { document } = mapNaverGame(await sanitizedNaverBundle());
        await workspace.saveReady(document, []);
        const gameId = document.metadata.gameId;
        const current = parseCurrentWorkspaceEntry(
          JSON.parse(
            await readFile(path.join(temp.path, "current", `${gameId}.json`), "utf8"),
          ) as unknown,
        );
        const original = await readFile(path.join(temp.path, current.artifactPath), "utf8");
        const activeDirectory = path.join(temp.path, "active", gameId);
        if (retainedFile) await writeFile(path.join(activeDirectory, "notes.txt"), "preserved");
        await workspace.removeImportedStaging(
          document.metadata.season,
          gameId,
          stagingDocumentHash(document),
        );
        if (retainedFile) expect(await readdir(activeDirectory)).toEqual(["notes.txt"]);
        else await expect(readdir(activeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await readFile(
            path.join(temp.path, "superseded", gameId, path.basename(current.artifactPath)),
            "utf8",
          ),
        ).toBe(original);
        expect(await workspace.readOriginal(document.metadata.season, gameId)).toEqual(document);
      } finally {
        await workspace.close();
      }
    },
  );
});
