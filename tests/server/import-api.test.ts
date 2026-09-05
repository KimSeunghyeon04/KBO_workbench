import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../apps/server/src/app.js";
import type { AppConfig } from "../../apps/server/src/config.js";
import { ImportJobManager } from "../../apps/server/src/jobs/import-job-manager.js";

describe("import HTTP API", () => {
  it("web 요청을 비동기 적재 job으로 만들고 revision 결과를 조회한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-api-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    await workspace.saveReady(document, []);
    const manager = new ImportJobManager(workspace, {
      catalog: async () => [],
      importRevision: async () => ({
        gameId: document.metadata.gameId,
        revision: 1,
        documentHash: stagingDocumentHash(document),
        projectionHash: "b".repeat(64),
      }),
    });
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: emptyCollectionJobs(),
      revisionStore: {
        catalog: async () => [],
        countStoredGames: async () => 0,
        hydrate: async () => {
          throw new Error("unexpected hydrate");
        },
        revisions: async () => ({
          gameId: document.metadata.gameId,
          currentRevision: 1,
          revisions: [],
        }),
      },
      importJobs: manager,
      correctionSessions: emptyCorrectionSessions(),
      async close() {
        await manager.close();
        await workspace.close();
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v2/import-jobs",
      payload: { gameId: document.metadata.gameId, idempotencyKey: "import-api-key" },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json<{ readonly jobId: string }>().jobId;
    await manager.waitForTerminal(jobId);

    const response = await app.inject({ method: "GET", url: `/api/v2/import-jobs/${jobId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      gameId: document.metadata.gameId,
      status: "succeeded",
      revision: 1,
    });
    const revisions = await app.inject({
      method: "GET",
      url: `/api/v2/games/${document.metadata.gameId}/revisions`,
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toMatchObject({ currentRevision: 1 });

    const batchRequest = { idempotencyKey: "import-ready-batch-api-key" };
    const batchCreated = await app.inject({
      method: "POST",
      url: "/api/v2/import-jobs/batch",
      payload: batchRequest,
    });
    expect(batchCreated.statusCode).toBe(202);
    expect(batchCreated.json()).toMatchObject({ createdCount: 0, skippedCount: 0, jobs: [] });
    const repeatedBatch = await app.inject({
      method: "POST",
      url: "/api/v2/import-jobs/batch",
      payload: batchRequest,
    });
    expect(repeatedBatch.json()).toEqual(batchCreated.json());
    await app.close();
  });
});

function emptyCollectionJobs() {
  return {
    close: async () => undefined,
    create: () => {
      throw new Error("unexpected collection create");
    },
    get: () => {
      throw new Error("unexpected collection get");
    },
    list: () => [],
    cancel: () => {
      throw new Error("unexpected collection cancel");
    },
    eventsAfter: () => [],
    subscribe: () => () => undefined,
  } as never;
}

function emptyCorrectionSessions() {
  return {
    close: () => undefined,
    command: () => {
      throw new Error("unexpected correction command");
    },
    commit: async () => {
      throw new Error("unexpected correction commit");
    },
    create: async () => {
      throw new Error("unexpected correction create");
    },
    delete: () => undefined,
    get: () => {
      throw new Error("unexpected correction get");
    },
    redo: () => {
      throw new Error("unexpected correction redo");
    },
    undo: () => {
      throw new Error("unexpected correction undo");
    },
  } as never;
}

function testConfig(workspacePath: string): AppConfig {
  return {
    apiVersion: "test",
    collection: {
      maxConcurrentJobs: 1,
      maxAttempts: 1,
      requestsPerSecond: 100,
      timeoutMs: 1_000,
    },
    recordCorrection: testRecordCorrectionConfig(),
    database: { database: "test", host: "db", password: "test", port: 5432, user: "test" },
    expectedMigrationVersion: "0004_pitch_metadata",
    host: "127.0.0.1",
    port: 3000,
    workspacePath,
  };
}

function testRecordCorrectionConfig() {
  return {
    autoSync: false,
    maxAttempts: 1,
    requestsPerSecond: 100,
    timeoutMs: 1_000,
    syncIntervalMs: 86_400_000,
    retryIntervalMs: 21_600_000,
  };
}
