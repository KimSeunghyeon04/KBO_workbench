import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStagingGameDocumentV2, type StagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import type { ReplaySourceData } from "@kbo/replay";
import { StagingWorkspace } from "@kbo/persistence";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../apps/server/src/app.js";
import type { AppConfig } from "../../apps/server/src/config.js";
import { ComputationPool } from "../../apps/server/src/computation-pool.js";
import { compileDocument } from "../../apps/server/src/computation.js";
import { storedCompilerFindings } from "../../apps/server/src/source-projection.js";

describe("replay HTTP API", () => {
  it("명시한 DB revision의 manifest와 cursor frame page를 strict 응답으로 제공한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-replay-api-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const loadCompiled = vi.fn(async (gameId: string, revision?: number) => ({
      gameId,
      revision: revision ?? 1,
      documentHash: stagingDocumentHash(document),
      projectionHash: "c".repeat(64),
      source: sourceData(document),
      replay: compileStagingGameDocumentV2(document),
    }));
    const pool = {
      query: vi.fn(async () => ({ rows: [{ pitchId: "e2", season: 2026, heightCm: 180 }] })),
      end: vi.fn(async () => undefined),
    } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: emptyCollectionJobs(),
      revisionStore: {
        catalog: async () => [],
        storedGameIds: async () => [],
        countStoredGames: async () => 0,
        loadCompiled,
        revisions: unexpected,
      } as never,
      importJobs: emptyImportJobs(),
      correctionSessions: emptyCorrectionSessions(),
      async close() {
        await workspace.close();
      },
    });

    const base = `/api/v2/games/${document.metadata.gameId}/revisions/1`;
    const manifest = await app.inject({ method: "GET", url: `${base}/replay-manifest` });
    expect(manifest.statusCode, manifest.body).toBe(200);
    expect(manifest.json()).toMatchObject({
      gameId: document.metadata.gameId,
      revision: 1,
      frameCount: compileStagingGameDocumentV2(document).plays.length,
    });

    const first = await app.inject({ method: "GET", url: `${base}/replay-frames?limit=3` });
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json<{
      readonly frames: readonly { readonly playNumber: number }[];
      readonly nextCursor: string;
    }>();
    expect(firstBody.frames.map((frame) => frame.playNumber)).toEqual([1, 2, 3]);

    const next = await app.inject({
      method: "GET",
      url: `${base}/replay-frames?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json()).toMatchObject({ startIndex: 3 });

    const invalid = await app.inject({
      method: "GET",
      url: `${base}/replay-frames?cursor=not-a-cursor`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_replay_cursor", category: "domain" });
    expect(loadCompiled).toHaveBeenCalledWith(document.metadata.gameId, 1);
    expect(loadCompiled).toHaveBeenCalledTimes(1);
    await app.inject({ method: "GET", url: `${base}/replay-manifest` });
    expect(loadCompiled).toHaveBeenCalledTimes(2);
    loadCompiled.mockRejectedValueOnce(new Error("sealed integrity failure"));
    const corrupt = await app.inject({ method: "GET", url: `${base}/replay-manifest` });
    expect(corrupt.statusCode).toBe(500);
    expect(loadCompiled).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it.each([
    ["game-document-v2.golden.json", "staging"],
    ["correction-record-mismatch.anonymized.json", "quarantine"],
  ] as const)(
    "%s를 worker에서 한 번 검증하고 %s에 저장하며 계산 실패는 기존 파일을 보존한다",
    async (fixture, authority) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-reopen-worker-"));
      const computation = new ComputationPool(1);
      const compile = vi.fn((document: StagingGameDocumentV2) =>
        compileDocument(computation, document),
      );
      const workspace = await StagingWorkspace.open(temporary.path, undefined, compile);
      const document = parseStagingGameDocumentV2(
        JSON.parse(await readFile(`tests/fixtures/${fixture}`, "utf8")) as unknown,
      );
      const loadCorrectionDraft = vi.fn(async () => document);
      const app = createApp(testConfig(temporary.path), new Pool(), {
        workspace,
        collectionJobs: emptyCollectionJobs(),
        revisionStore: {
          catalog: unexpected,
          catalogPage: unexpected,
          catalogSeasons: unexpected,
          storedGameIds: unexpected,
          countStoredGames: unexpected,
          currentRevisionBase: unexpected,
          loadCompiled: unexpected,
          revisions: unexpected,
          loadCorrectionDraft,
        },
        importJobs: emptyImportJobs(),
        correctionSessions: emptyCorrectionSessions(),
        close: () => workspace.close(),
      });
      try {
        await computation.warmup();
        const url = `/api/v2/games/${document.metadata.gameId}/revisions/1/correction-drafts`;
        const opened = await app.inject({ method: "POST", url });
        expect(opened.statusCode, opened.body).toBe(201);
        expect(parseStagingGameDocumentV2(opened.json())).toEqual(document);
        expect(loadCorrectionDraft).toHaveBeenCalledWith(document.metadata.gameId, 1);
        expect(compile).toHaveBeenCalledExactlyOnceWith(document);
        const saved = await workspace.readCurrentDocumentSnapshot(document.metadata.gameId);
        expect(saved).toEqual({
          authority,
          season: document.metadata.season,
          document,
          findings: storedCompilerFindings(compileStagingGameDocumentV2(document).findings),
        });
        const currentPath = path.join(
          temporary.path,
          "current",
          `${document.metadata.gameId}.json`,
        );
        const currentBefore = await readFile(currentPath, "utf8");
        const originalBefore = await workspace.readOriginal(
          document.metadata.season,
          document.metadata.gameId,
        );
        compile.mockRejectedValueOnce(new Error("worker compile failed"));
        const failed = await app.inject({ method: "POST", url });
        expect(failed.statusCode).toBe(500);
        expect(compile).toHaveBeenCalledTimes(2);
        expect(await readFile(currentPath, "utf8")).toBe(currentBefore);
        expect(
          await workspace.readOriginal(document.metadata.season, document.metadata.gameId),
        ).toEqual(originalBefore);
        expect(await workspace.readCurrentDocumentSnapshot(document.metadata.gameId)).toEqual(
          saved,
        );
      } finally {
        await app.close();
        await computation.close();
      }
    },
  );
});

async function unexpected(): Promise<never> {
  throw new Error("unexpected call");
}

function sourceData(document: StagingGameDocumentV2): ReplaySourceData {
  return {
    gameId: document.metadata.gameId,
    gameDate: document.metadata.gameDate,
    status: document.metadata.status,
    teams: document.teams,
    rosters: Object.fromEntries(
      (["away", "home"] as const).map((side) => [
        side,
        document.rosters[side].players.map((player) => ({
          playerId: player.playerId,
          name: player.name,
          battingOrder: player.battingOrder ?? null,
          starter: player.starter,
          positions: player.positions,
        })),
      ]),
    ) as ReplaySourceData["rosters"],
    relayEvents: document.events.map((event) => ({
      eventId: event.identity.eventId,
      sequence: event.sequence,
      kind: event.kind,
      relayText: event.relayText ?? null,
      substitution: event.kind === "substitution" ? event.payload : null,
    })),
    trackingCandidates: document.trackingCandidates,
  };
}

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

function emptyImportJobs() {
  return {
    close: async () => undefined,
    create: unexpected,
    get: unexpected,
    list: () => [],
  } as never;
}

function emptyCorrectionSessions() {
  return {
    close: () => undefined,
    command: unexpected,
    commit: unexpected,
    create: unexpected,
    delete: () => undefined,
    get: unexpected,
    redo: unexpected,
    undo: unexpected,
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
