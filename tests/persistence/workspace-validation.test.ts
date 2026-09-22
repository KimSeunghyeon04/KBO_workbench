import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { parseCurrentWorkspaceEntry, parseStagingGameDocumentV2 } from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { WorkspaceValidationPool } from "../../packages/persistence/src/workspace-validation-pool.js";

describe("workspace validation and import selection", () => {
  it("workers enforce the same full integrity checks and validated targets track live manifests", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-validation-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const pool = new WorkspaceValidationPool(true);
    try {
      const document = parseStagingGameDocumentV2(
        JSON.parse(
          await readFile("tests/fixtures/game-document-v2.golden.json", "utf8"),
        ) as unknown,
      );
      await workspace.saveReady(document, []);
      const manifestPath = path.join(temp.path, "current", `${document.metadata.gameId}.json`);
      const manifestText = await readFile(manifestPath, "utf8");
      const current = parseCurrentWorkspaceEntry(JSON.parse(manifestText) as unknown);
      expect(await pool.validate(temp.path, current)).toMatchObject({
        blockingFindings: 0,
        target: { documentHash: current.documentHash, revision: 1 },
      });
      const read = vi.spyOn(workspace, "readDocument");
      const target = (await workspace.readImportTargets([document.metadata.gameId]))[0];
      expect(target).toMatchObject({ documentHash: current.documentHash });
      expect(read).not.toHaveBeenCalled();
      await writeFile(manifestPath, JSON.stringify({ ...current, documentHash: "a".repeat(64) }));
      await expect(workspace.readImportTargets([document.metadata.gameId])).rejects.toThrow(
        "무결성",
      );
      await writeFile(manifestPath, manifestText);
      await writeFile(path.join(temp.path, current.artifactPath), "{}");
      await expect(pool.validate(temp.path, current)).rejects.toThrow();
      await expect(
        workspace.readDocument("staging", document.metadata.season, document.metadata.gameId),
      ).rejects.toThrow();
    } finally {
      await pool.close();
      await workspace.close();
    }
  });
});
