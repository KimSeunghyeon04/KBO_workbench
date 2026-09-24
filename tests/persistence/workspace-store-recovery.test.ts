import { mkdtempDisposable, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapNaverGame } from "@kbo/collection";
import {
  canonicalStringify,
  parseCorrectionJournal,
  parseWriterLockOwner,
  type CollectionJob,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace } from "@kbo/persistence";

import { sanitizedNaverBundle } from "../helpers/naver.js";

const originalFinding = {
  producer: "collection" as const,
  lifecycle: "persistent" as const,
  code: "source.original",
  category: "source" as const,
  severity: "warning" as const,
  message: "최초 관측",
};

function collectionJob(jobId: string, createdAt: string): CollectionJob {
  return {
    jobId,
    kind: "collection",
    status: "running",
    createdAt,
    startedAt: createdAt,
    finishedAt: null,
    completedItems: 1,
    totalItems: 2,
    currentGameId: "20260820AABB",
    scope: { kind: "game_ids", gameIds: ["20260820AABB"] },
    summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
    skippedItems: 0,
    error: null,
    errorCategory: null,
  };
}

describe("workspace original and journal boundaries", () => {
  it.each(["invalid", "different_game"] as const)(
    "%s 원본이 있으면 재수집으로 덮어쓰거나 current를 바꾸지 않는다",
    async (kind) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-original-invalid-"));
      const workspace = await StagingWorkspace.open(temporary.path);
      try {
        const { document } = mapNaverGame(await sanitizedNaverBundle());
        await workspace.saveReady(document, [originalFinding]);
        const originalPath = path.join(
          temporary.path,
          "original",
          String(document.metadata.season),
          `${document.metadata.gameId}.json`,
        );
        const badOriginal =
          kind === "invalid"
            ? "{}\n"
            : `${canonicalStringify({
                ...document,
                metadata: { ...document.metadata, gameId: "20260820OTHER" },
              })}\n`;
        await writeFile(originalPath, badOriginal);
        const currentPath = path.join(
          temporary.path,
          "current",
          `${document.metadata.gameId}.json`,
        );
        const beforeCurrent = await readFile(currentPath, "utf8");
        await expect(
          workspace.saveReady(
            {
              ...document,
              source: { ...document.source, collectedAt: "2026-08-21T00:00:00.000Z" },
            },
            [],
          ),
        ).rejects.toThrow();
        expect(await readFile(originalPath, "utf8")).toBe(badOriginal);
        expect(await readFile(currentPath, "utf8")).toBe(beforeCurrent);
        expect(
          await workspace.readOriginalFindings(document.metadata.season, document.metadata.gameId),
        ).toEqual([originalFinding]);
      } finally {
        await workspace.close();
      }
    },
  );

  it("최초 finding이 없으면 후속 수집의 finding을 원본에 추가하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-original-empty-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    try {
      const { document } = mapNaverGame(await sanitizedNaverBundle());
      await workspace.saveReady(document, []);
      await workspace.saveReady(document, [originalFinding]);
      expect(
        await workspace.readOriginalFindings(document.metadata.season, document.metadata.gameId),
      ).toEqual([]);
      expect(
        await workspace.readFindings("staging", document.metadata.season, document.metadata.gameId),
      ).toEqual([originalFinding]);
      expect(
        await readdir(path.join(temporary.path, "original", String(document.metadata.season))),
      ).toEqual([`${document.metadata.gameId}.json`]);
    } finally {
      await workspace.close();
    }
  });

  it.each(["invalid_schema", "blocking_promotion"] as const)(
    "%s 저널은 복구 실패 시 원본·current·저널을 보존하고 잠금을 해제한다",
    async (kind) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-journal-rejected-"));
      const workspace = await StagingWorkspace.open(temporary.path);
      const { document } = mapNaverGame(await sanitizedNaverBundle());
      try {
        await workspace.saveReady(document, [originalFinding]);
        await expect(
          workspace.commitCorrection(
            {
              baseAuthority: "staging",
              targetAuthority: "staging",
              baseDocumentHash: stagingDocumentHash(document),
              document: {
                ...document,
                source: { ...document.source, collectedAt: "2026-08-21T00:00:00.000Z" },
              },
              findingEnvelope: { schemaVersion: 2, findings: [] },
            },
            "after_journal",
          ),
        ).rejects.toThrow("after_journal");
      } finally {
        await workspace.close();
      }
      const journalName = (await readdir(path.join(temporary.path, "journals"))).find((name) =>
        name.startsWith("correction-"),
      );
      if (journalName === undefined) throw new Error("correction journal missing");
      const journalPath = path.join(temporary.path, "journals", journalName);
      const journal = parseCorrectionJournal(
        JSON.parse(await readFile(journalPath, "utf8")) as unknown,
      );
      const rejected =
        kind === "invalid_schema"
          ? { ...journal, unexpected: true }
          : {
              ...journal,
              findingEnvelope: {
                schemaVersion: 2,
                findings: [{ ...originalFinding, severity: "blocking" }],
              },
            };
      const journalBytes = `${canonicalStringify(rejected)}\n`;
      await writeFile(journalPath, journalBytes);
      const currentPath = path.join(temporary.path, "current", `${document.metadata.gameId}.json`);
      const originalPath = path.join(
        temporary.path,
        "original",
        String(document.metadata.season),
        `${document.metadata.gameId}.json`,
      );
      const beforeCurrent = await readFile(currentPath, "utf8");
      const beforeOriginal = await readFile(originalPath, "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(StagingWorkspace.open(temporary.path)).rejects.toThrow();
        await expect(readFile(path.join(temporary.path, ".writer.lock"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(journalPath, "utf8")).toBe(journalBytes);
        expect(await readFile(currentPath, "utf8")).toBe(beforeCurrent);
        expect(await readFile(originalPath, "utf8")).toBe(beforeOriginal);
      }
    },
  );

  it.each(["closed", "lost_lock"] as const)(
    "%s workspace는 원본과 저널의 쓰기·제거·복구를 수행하지 않는다",
    async (state) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-store-guard-"));
      const workspace = await StagingWorkspace.open(temporary.path);
      try {
        const { document } = mapNaverGame(await sanitizedNaverBundle());
        const job = collectionJob("guarded-job", "2026-08-20T01:00:00.000Z");
        await workspace.saveCollectionJobJournal(job);
        const journalPath = path.join(temporary.path, "journals", `collection-${job.jobId}.json`);
        const beforeJournal = await readFile(journalPath, "utf8");
        if (state === "closed") await workspace.close();
        else {
          const lockPath = path.join(temporary.path, ".writer.lock");
          const owner = parseWriterLockOwner(
            JSON.parse(await readFile(lockPath, "utf8")) as unknown,
          );
          await writeFile(lockPath, canonicalStringify({ ...owner, token: "different-owner" }));
        }
        const expected = state === "closed" ? "닫힌 workspace" : "lock 소유권";
        await expect(workspace.saveReady(document, [])).rejects.toThrow(expected);
        await expect(
          workspace.saveCollectionJobJournal({ ...job, completedItems: 2 }),
        ).rejects.toThrow(expected);
        await expect(workspace.removeCollectionJobJournal(job.jobId)).rejects.toThrow(expected);
        await expect(workspace.recoverInterruptedCollectionJobs()).rejects.toThrow(expected);
        await expect(
          workspace.commitCorrection({
            baseAuthority: "staging",
            targetAuthority: "staging",
            baseDocumentHash: stagingDocumentHash(document),
            document,
            findingEnvelope: { schemaVersion: 2, findings: [] },
          }),
        ).rejects.toThrow(expected);
        expect(await readFile(journalPath, "utf8")).toBe(beforeJournal);
        expect(await readdir(path.join(temporary.path, "original"))).toEqual([]);
        expect(await readdir(path.join(temporary.path, "current"))).toEqual([]);
        expect(await readdir(path.join(temporary.path, "journals"))).toEqual([
          `collection-${job.jobId}.json`,
        ]);
      } finally {
        await workspace.close();
      }
    },
  );

  it("수집 복구는 생성 시각 역순으로 완료 결과를 유지하고 대상 저널만 제거한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-journal-order-"));
    const now = "2026-08-20T03:00:00.000Z";
    const workspace = await StagingWorkspace.open(temporary.path, () => new Date(now));
    try {
      const older = collectionJob("z-older", "2026-08-20T01:00:00.000Z");
      const newer = collectionJob("a-newer", "2026-08-20T02:00:00.000Z");
      await workspace.saveCollectionJobJournal(older);
      await workspace.saveCollectionJobJournal(newer);
      await writeFile(path.join(temporary.path, "journals", "unrelated.json"), "{}\n");
      await writeFile(
        path.join(temporary.path, "journals", "collection-pending.tmp"),
        "incomplete",
      );
      expect(await workspace.recoverInterruptedCollectionJobs()).toEqual(
        [newer, older].map((job) => ({
          ...job,
          status: "failed",
          currentGameId: null,
          finishedAt: now,
          error: "API 재시작으로 수집 작업이 중단됐습니다.",
          errorCategory: "persistence",
        })),
      );
      expect(await readdir(path.join(temporary.path, "journals"))).toEqual([
        "collection-pending.tmp",
        "unrelated.json",
      ]);
      expect(await workspace.recoverInterruptedCollectionJobs()).toEqual([]);
      await expect(
        workspace.removeCollectionJobJournal("already-removed"),
      ).resolves.toBeUndefined();
    } finally {
      await workspace.close();
    }
  });
});
