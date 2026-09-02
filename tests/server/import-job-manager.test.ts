import { readFile } from "node:fs/promises";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  ImportIdempotencyConflictError,
  ImportJobManager,
} from "../../apps/server/src/jobs/import-job-manager.js";

describe("ImportJobManager", () => {
  it("staging 문서를 revision importer에 넘기고 hash 결과를 job에 남긴다", async () => {
    const document = await goldenDocument();
    const importRevision = vi.fn(async () => ({
      gameId: document.metadata.gameId,
      revision: 1,
      documentHash: "a".repeat(64),
      projectionHash: "b".repeat(64),
    }));
    const removeImportedStaging = vi.fn(async () => undefined);
    const afterImport = vi.fn(async () => undefined);
    const manager = new ImportJobManager(
      {
        catalog: async () => ({
          games: [
            {
              gameId: document.metadata.gameId,
              season: document.metadata.season,
              authority: "staging",
              updatedAt: "2026-08-21T00:00:00.000Z",
              blockingFindings: 0,
              warningFindings: 0,
            },
          ],
        }),
        readDocument: async () => document,
        readOriginal: async () => document,
        removeImportedStaging,
      },
      { importRevision },
      () => new Date("2026-08-21T00:00:00.000Z"),
      () => "import-job-1",
      2,
      afterImport,
    );
    const request = { gameId: document.metadata.gameId, idempotencyKey: "same-import-key" };
    const created = manager.create(request);

    expect(manager.create(request).jobId).toBe(created.jobId);
    expect(() =>
      manager.create({ gameId: "another-game", idempotencyKey: "same-import-key" }),
    ).toThrow(ImportIdempotencyConflictError);
    await expect(manager.waitForTerminal(created.jobId)).resolves.toMatchObject({
      status: "succeeded",
      revision: 1,
      documentHash: "a".repeat(64),
      projectionHash: "b".repeat(64),
    });
    expect(importRevision).toHaveBeenCalledWith(document);
    expect(removeImportedStaging).toHaveBeenCalledWith(
      document.metadata.season,
      document.metadata.gameId,
      "a".repeat(64),
    );
    expect(afterImport).toHaveBeenCalledWith(document.metadata.gameId, 1, "a".repeat(64));
    await manager.close();
  });

  it("staging ready가 아닌 경기는 failed job으로 남긴다", async () => {
    const manager = new ImportJobManager(
      {
        catalog: async () => ({ games: [] }),
        readDocument: async () => {
          throw new Error("unexpected read");
        },
        readOriginal: async () => {
          throw new Error("unexpected original read");
        },
      },
      {
        importRevision: async () => {
          throw new Error("unexpected import");
        },
      },
      () => new Date("2026-08-21T00:00:00.000Z"),
      () => "import-job-missing",
    );
    const created = manager.create({ gameId: "missing", idempotencyKey: "missing-import-key" });
    await expect(manager.waitForTerminal(created.jobId)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("staging ready"),
      errorCategory: "domain",
    });
    await manager.close();
  });

  it("DB adapter 실패는 persistence 범주를 유지한다", async () => {
    const document = await goldenDocument();
    const manager = new ImportJobManager(
      {
        catalog: async () => ({
          games: [
            {
              gameId: document.metadata.gameId,
              season: document.metadata.season,
              authority: "staging",
              updatedAt: "2026-08-21T00:00:00.000Z",
              blockingFindings: 0,
              warningFindings: 0,
            },
          ],
        }),
        readDocument: async () => document,
        readOriginal: async () => document,
      },
      { importRevision: async () => Promise.reject(new Error("DB 연결이 끊겼습니다.")) },
      () => new Date("2026-08-21T00:00:00.000Z"),
      () => "import-job-db-failure",
    );
    const job = manager.create({
      gameId: document.metadata.gameId,
      idempotencyKey: "db-failure-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "failed",
      errorCategory: "persistence",
      error: "DB 연결이 끊겼습니다.",
    });
    await manager.close();
  });

  it("신규·revision staging 문서를 결정론적으로 골라 제한된 동시성으로 모두 처리한다", async () => {
    const document = await goldenDocument();
    let active = 0;
    let maximumActive = 0;
    const importedGameIds: string[] = [];
    const importRevision = vi.fn(async (input: unknown) => {
      const parsed = parseStagingGameDocumentV2(input);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      importedGameIds.push(parsed.metadata.gameId);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        gameId: parsed.metadata.gameId,
        revision: 1,
        documentHash: "a".repeat(64),
        projectionHash: "b".repeat(64),
      };
    });
    let nextId = 0;
    const readyGameIds = ["anon-game-c", "anon-game-a", "anon-game-b"];
    const manager = new ImportJobManager(
      {
        catalog: async () => ({
          games: [
            ...readyGameIds.map((gameId) => catalogGame(gameId, "staging")),
            catalogGame("anon-game-stored", "staging"),
          ],
        }),
        readDocument: async (_authority, _season, gameId) => ({
          ...document,
          metadata: { ...document.metadata, gameId },
        }),
      },
      {
        catalog: async () => [catalogGame("anon-game-stored", "database")],
        importRevision,
      },
      () => new Date("2026-08-21T00:00:00.000Z"),
      () => `generated-${String((nextId += 1))}`,
      2,
    );

    const batch = await manager.createReadyBatch({ idempotencyKey: "ready-batch-key" });
    expect(batch).toMatchObject({
      batchId: "generated-1",
      createdCount: 4,
      skippedCount: 0,
    });
    expect(batch.jobs.map((job) => job.gameId)).toEqual([
      "anon-game-a",
      "anon-game-b",
      "anon-game-c",
      "anon-game-stored",
    ]);
    await Promise.all(batch.jobs.map((job) => manager.waitForTerminal(job.jobId)));
    expect(maximumActive).toBe(2);
    expect(importedGameIds.sort()).toEqual([...readyGameIds, "anon-game-stored"].sort());
    await expect(manager.createReadyBatch({ idempotencyKey: "ready-batch-key" })).resolves.toEqual(
      batch,
    );
    expect(importRevision).toHaveBeenCalledTimes(4);
    await manager.close();
  });

  it("일괄 적재에서 한 경기 실패가 뒤 경기 실행을 중단하지 않는다", async () => {
    const document = await goldenDocument();
    const manager = new ImportJobManager(
      {
        catalog: async () => ({
          games: [
            catalogGame("anon-failing-game", "staging"),
            catalogGame("anon-success-game", "staging"),
          ],
        }),
        readDocument: async (_authority, _season, gameId) => ({
          ...document,
          metadata: { ...document.metadata, gameId },
        }),
      },
      {
        catalog: async () => [],
        importRevision: async (input: unknown) => {
          const parsed = parseStagingGameDocumentV2(input);
          if (parsed.metadata.gameId === "anon-failing-game") throw new Error("격리된 DB 오류");
          return {
            gameId: parsed.metadata.gameId,
            revision: 1,
            documentHash: "a".repeat(64),
            projectionHash: "b".repeat(64),
          };
        },
      },
      () => new Date("2026-08-21T00:00:00.000Z"),
      (() => {
        let nextId = 0;
        return () => `continued-${String((nextId += 1))}`;
      })(),
      1,
    );
    const batch = await manager.createReadyBatch({ idempotencyKey: "continue-batch-key" });
    const results = await Promise.all(batch.jobs.map((job) => manager.waitForTerminal(job.jobId)));
    expect(results.map((job) => [job.gameId, job.status])).toEqual([
      ["anon-failing-game", "failed"],
      ["anon-success-game", "succeeded"],
    ]);
    await manager.close();
  });
});

function catalogGame(gameId: string, authority: "staging" | "database") {
  return {
    gameId,
    season: 2026,
    authority,
    updatedAt: "2026-08-21T00:00:00.000Z",
    blockingFindings: 0,
    warningFindings: 0,
  } as const;
}

async function goldenDocument() {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}
