import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import {
  replayCompilerHash,
  replaySemanticHash,
  stagingSourceContentHash,
  V3TransferWorkspace,
} from "@kbo/persistence";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V2 current -> V3 transfer workspace", () => {
  it("원래 revision/hash와 normalized revision 1 원장을 gzip artifact에 보존한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kbo-v3-transfer-"));
    roots.push(root);
    const workspace = new V3TransferWorkspace(root);
    await workspace.initializeEmpty();
    const original = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const sourceDocument = parseStagingGameDocumentV2({
      ...original,
      revisionBase: {
        kind: "sealed_revision",
        revision: 1,
        documentHash: "1".repeat(64),
      },
    });
    const normalizedDocument = parseStagingGameDocumentV2({
      ...sourceDocument,
      revisionBase: { kind: "new_game" },
    });
    const replay = compileStagingGameDocumentV2(sourceDocument);
    const entry = await workspace.writeGame({
      document: sourceDocument,
      normalizedDocument,
      sourceRevision: 2,
      sourceDocumentHash: stagingDocumentHash(sourceDocument),
      sourceProjectionHash: "2".repeat(64),
      sourceBundleHash: sourceDocument.source.sourceBundleHash,
      sourceContentHash: stagingSourceContentHash(sourceDocument),
      normalizedDocumentHash: stagingDocumentHash(normalizedDocument),
      compilerHash: replayCompilerHash(replay),
      replaySemanticHash: replaySemanticHash(replay),
    });
    await workspace.writeManifest([entry]);

    const manifest = await workspace.readManifest();
    expect(manifest.games).toEqual([expect.objectContaining({ sourceRevision: 2 })]);
    const manifestEntry = manifest.games[0];
    expect(manifestEntry).toBeDefined();
    if (manifestEntry === undefined) return;
    const artifact = await workspace.readGame(manifestEntry);
    expect(artifact.document.revisionBase).toEqual(sourceDocument.revisionBase);
    expect(artifact.normalizedDocumentHash).toBe(stagingDocumentHash(normalizedDocument));
  });

  it("artifact 변조를 manifest hash에서 거부한다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kbo-v3-transfer-tamper-"));
    roots.push(root);
    const workspace = new V3TransferWorkspace(root);
    await workspace.initializeEmpty();
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const replay = compileStagingGameDocumentV2(document);
    const entry = await workspace.writeGame({
      document,
      normalizedDocument: document,
      sourceRevision: 1,
      sourceDocumentHash: stagingDocumentHash(document),
      sourceProjectionHash: "3".repeat(64),
      sourceBundleHash: document.source.sourceBundleHash,
      sourceContentHash: stagingSourceContentHash(document),
      normalizedDocumentHash: stagingDocumentHash(document),
      compilerHash: replayCompilerHash(replay),
      replaySemanticHash: replaySemanticHash(replay),
    });
    await writeFile(path.join(root, ...entry.artifactKey.split("/")), "tampered", "utf8");
    await expect(workspace.readGame(entry)).rejects.toThrow(/hash/);
  });
});
