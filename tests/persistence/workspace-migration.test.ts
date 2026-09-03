import { createHash } from "node:crypto";
import { mkdir, mkdtempDisposable, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapNaverGame } from "@kbo/collection";
import {
  canonicalStringify,
  parseCurrentWorkspaceEntry,
  type CurrentWorkspaceEntry,
  type LegacyCurrentWorkspaceEntryV1,
} from "@kbo/contracts";
import {
  migrateWorkspaceLayout,
  StagingWorkspace,
  WorkspaceMigrationRequiredError,
  WorkspacePersistenceBlockedError,
} from "@kbo/persistence";

import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("workspace layout migration", () => {
  it("dry-run은 변경하지 않고 apply는 검증된 backup 뒤 current manifest로 전환한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-migration-"));
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const legacyDirectory = path.join(temporary.path, "staging", String(document.metadata.season));
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      path.join(legacyDirectory, `${document.metadata.gameId}.json`),
      `${canonicalStringify(document)}\n`,
    );

    await expect(StagingWorkspace.open(temporary.path)).rejects.toBeInstanceOf(
      WorkspaceMigrationRequiredError,
    );
    const dryRun = await migrateWorkspaceLayout({ root: temporary.path, apply: false });
    expect(dryRun).toEqual({
      mode: "dry-run",
      legacyArtifactCount: 1,
      gameCount: 1,
      migratedCount: 0,
      conflicts: [],
      currentManifestV1Count: 0,
      upgradedManifestCount: 0,
      sourceFailureManifestCount: 0,
      derivableDisplaySummaryCount: 0,
      manifestValidationFailures: [],
    });
    expect(
      await readFile(path.join(legacyDirectory, `${document.metadata.gameId}.json`), "utf8"),
    ).toContain(document.metadata.gameId);

    const backupDirectory = await createVerifiedBackup(temporary.path);
    const applied = await migrateWorkspaceLayout({
      root: temporary.path,
      apply: true,
      backupDirectory,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(applied.migratedCount).toBe(1);
    const workspace = await StagingWorkspace.open(temporary.path);
    expect((await workspace.catalog()).games).toEqual([
      expect.objectContaining({
        gameId: document.metadata.gameId,
        authority: "staging",
        supersededCount: 0,
      }),
    ]);
    expect(
      await workspace.readDocument("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    await workspace.close();
    expect(
      await readdir(path.join(temporary.path, "migration-archive", document.metadata.gameId)),
    ).toEqual([expect.stringContaining(`${document.metadata.gameId}.json`)]);
  });

  it("동일 경기의 dual current 후보는 resolution 없이 적용하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-migration-conflict-"));
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    for (const authority of ["staging", "quarantine"] as const) {
      const directory = path.join(temporary.path, authority, String(document.metadata.season));
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, `${document.metadata.gameId}.json`),
        `${canonicalStringify(document)}\n`,
      );
    }
    const dryRun = await migrateWorkspaceLayout({ root: temporary.path, apply: false });
    expect(dryRun.conflicts).toEqual([
      {
        gameId: document.metadata.gameId,
        candidates: [
          expect.objectContaining({ authority: "quarantine" }),
          expect.objectContaining({ authority: "staging" }),
        ],
      },
    ]);
    const backupDirectory = await createVerifiedBackup(temporary.path);
    await expect(
      migrateWorkspaceLayout({ root: temporary.path, apply: true, backupDirectory }),
    ).rejects.toThrow("--resolution");
  });

  it("V1 current manifest는 dry-run에서만 보고하고 검증된 apply로 요약을 승격한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-manifest-v1-"));
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const workspace = await StagingWorkspace.open(temporary.path);
    await workspace.saveReady(document, []);
    await workspace.close();

    const currentPath = path.join(temporary.path, "current", `${document.metadata.gameId}.json`);
    const current = parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8")));
    const artifactBefore = await readFile(
      path.join(temporary.path, ...current.artifactPath.split("/")),
    );
    const legacy = toLegacyManifest(current);
    await writeFile(currentPath, `${canonicalStringify(legacy)}\n`);

    await expect(StagingWorkspace.open(temporary.path)).rejects.toBeInstanceOf(
      WorkspacePersistenceBlockedError,
    );
    await expect(StagingWorkspace.open(temporary.path)).rejects.toThrow(
      "pnpm workspace:migrate -- --dry-run",
    );

    const dryRun = await migrateWorkspaceLayout({ root: temporary.path, apply: false });
    expect(dryRun).toMatchObject({
      currentManifestV1Count: 1,
      upgradedManifestCount: 0,
      sourceFailureManifestCount: 0,
      derivableDisplaySummaryCount: 1,
      manifestValidationFailures: [],
    });
    expect(JSON.parse(await readFile(currentPath, "utf8"))).toEqual(legacy);

    const backupDirectory = await createVerifiedBackup(temporary.path);
    const applied = await migrateWorkspaceLayout({
      root: temporary.path,
      apply: true,
      backupDirectory,
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(applied.upgradedManifestCount).toBe(1);
    const upgraded = parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8")));
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      displaySummary: { gameDate: document.metadata.gameDate, teams: document.teams },
    });
    expect(await readFile(path.join(temporary.path, ...upgraded.artifactPath.split("/")))).toEqual(
      artifactBefore,
    );
  });

  it("V1 current가 가리키는 artifact hash가 다르면 apply를 중단한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-manifest-hash-"));
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const workspace = await StagingWorkspace.open(temporary.path);
    await workspace.saveReady(document, []);
    await workspace.close();

    const currentPath = path.join(temporary.path, "current", `${document.metadata.gameId}.json`);
    const current = parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8")));
    await writeFile(
      currentPath,
      `${canonicalStringify({ ...toLegacyManifest(current), contentHash: "f".repeat(64) })}\n`,
    );

    const dryRun = await migrateWorkspaceLayout({ root: temporary.path, apply: false });
    expect(dryRun.currentManifestV1Count).toBe(1);
    expect(dryRun.manifestValidationFailures).toEqual([
      expect.objectContaining({ gameId: document.metadata.gameId }),
    ]);
    const backupDirectory = await createVerifiedBackup(temporary.path);
    await expect(
      migrateWorkspaceLayout({ root: temporary.path, apply: true, backupDirectory }),
    ).rejects.toThrow("current manifest 검증 실패");
  });

  it("source failure V1은 날짜나 팀을 추론하지 않고 null 요약으로 승격한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-manifest-failure-"));
    const gameId = "unobserved-source-failure";
    const workspace = await StagingWorkspace.open(temporary.path);
    await workspace.saveSourceFailure(gameId, [
      {
        producer: "collection",
        lifecycle: "persistent",
        code: "source.unavailable",
        category: "source",
        severity: "blocking",
        message: "비식별 원천 실패",
      },
    ]);
    await workspace.close();

    const currentPath = path.join(temporary.path, "current", `${gameId}.json`);
    const current = parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8")));
    await writeFile(currentPath, `${canonicalStringify(toLegacyManifest(current))}\n`);
    const dryRun = await migrateWorkspaceLayout({ root: temporary.path, apply: false });
    expect(dryRun).toMatchObject({
      currentManifestV1Count: 1,
      sourceFailureManifestCount: 1,
      derivableDisplaySummaryCount: 0,
    });

    const backupDirectory = await createVerifiedBackup(temporary.path);
    await migrateWorkspaceLayout({ root: temporary.path, apply: true, backupDirectory });
    expect(
      parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8"))),
    ).toMatchObject({
      authority: "source_failure",
      season: null,
      displaySummary: null,
    });
  });
});

function toLegacyManifest(current: CurrentWorkspaceEntry): LegacyCurrentWorkspaceEntryV1 {
  return {
    schemaVersion: 1,
    gameId: current.gameId,
    season: current.season,
    authority: current.authority,
    generation: current.generation,
    updatedAt: current.updatedAt,
    artifactPath: current.artifactPath,
    contentHash: current.contentHash,
    documentHash: current.documentHash,
  };
}

async function createVerifiedBackup(root: string): Promise<string> {
  const directory = path.join(root, "test-backup");
  await mkdir(directory, { recursive: true });
  const database = Buffer.from("isolated database backup", "utf8");
  const workspace = Buffer.from("isolated workspace backup", "utf8");
  await writeFile(path.join(directory, "postgres.dump"), database);
  await writeFile(path.join(directory, "workspace.zip"), workspace);
  await writeFile(
    path.join(directory, "manifest.json"),
    `${canonicalStringify({
      formatVersion: 1,
      database: { file: "postgres.dump", sha256: sha256(database) },
      workspace: { file: "workspace.zip", sha256: sha256(workspace) },
    })}\n`,
  );
  return directory;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
