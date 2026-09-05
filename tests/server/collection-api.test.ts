import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { CollectedGame } from "@kbo/collection";
import { StagingWorkspace } from "@kbo/persistence";

import { createApp } from "../../apps/server/src/app.js";
import type { AppConfig } from "../../apps/server/src/config.js";
import { CollectionJobManager } from "../../apps/server/src/jobs/collection-job-manager.js";
import type { AppRuntime } from "../../apps/server/src/runtime.js";
import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("collection HTTP API", () => {
  it("job 생성·조회·catalog를 strict response로 제공한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-api-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = await sanitizedNaverBundle();
    const jobs = new CollectionJobManager(
      { discoverRange: async () => [] },
      {
        async collect(): Promise<CollectedGame> {
          return { gameId: bundle.gameId, disposition: "collected", bundle, findings: [] };
        },
      },
      workspace,
    );
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: jobs,
      ...emptyPersistenceRuntime(),
      async close() {
        await jobs.close();
        await workspace.close();
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v2/collection-jobs",
      payload: {
        scope: { kind: "game_ids", gameIds: [bundle.gameId] },
        idempotencyKey: "api-request-key",
      },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json<{ jobId: string }>().jobId;
    expect((await jobs.waitForTerminal(jobId)).status).toBe("succeeded");

    const response = await app.inject({ method: "GET", url: `/api/v2/collection-jobs/${jobId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "succeeded", completedItems: 1 });
    const catalog = await app.inject({ method: "GET", url: "/api/v2/games?authority=staging" });
    expect(catalog.json()).toEqual({
      games: [expect.objectContaining({ gameId: bundle.gameId, authority: "staging" })],
    });
    const catalogRead = vi
      .spyOn(workspace, "catalog")
      .mockRejectedValue(new Error("단일 경기 조회에서 전체 catalog를 읽으면 안 됩니다."));
    const document = await app.inject({
      method: "GET",
      url: `/api/v2/games/${bundle.gameId}`,
    });
    expect(document.statusCode).toBe(200);
    expect(document.json()).toMatchObject({
      schemaVersion: 2,
      metadata: { gameId: bundle.gameId },
    });
    expect(catalogRead).not.toHaveBeenCalled();
    await app.close();
    expect(pool.end).toHaveBeenCalledOnce();
  }, 10_000);

  it("잘못된 request body를 공통 400 오류로 반환한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-api-invalid-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const jobs = new CollectionJobManager(
      { discoverRange: async () => [] },
      {
        collect: async () => ({
          gameId: "none",
          disposition: "source_failure",
          bundle: null,
          findings: [],
        }),
      },
      workspace,
    );
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: jobs,
      ...emptyPersistenceRuntime(),
      async close() {
        await jobs.close();
        await workspace.close();
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/collection-jobs",
      payload: { scope: { kind: "date_range", startDate: "bad", endDate: "bad" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request", category: "domain" });
    await app.close();
  });
});

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

function emptyPersistenceRuntime(): Pick<
  AppRuntime,
  "revisionStore" | "importJobs" | "correctionSessions"
> {
  return {
    revisionStore: {
      catalog: async () => [],
      countStoredGames: async () => 0,
      hydrate: async () => {
        throw new Error("unexpected hydrate");
      },
      revisions: async () => {
        throw new Error("unexpected revisions");
      },
    },
    importJobs: {
      close: async () => undefined,
      create: () => {
        throw new Error("unexpected import create");
      },
      createReadyBatch: async () => {
        throw new Error("unexpected import batch create");
      },
      get: () => {
        throw new Error("unexpected import get");
      },
      list: () => [],
    },
    correctionSessions: emptyCorrectionSessions(),
  };
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
