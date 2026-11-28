import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { parseStagingGameDocumentV2, type ImportJobRecord } from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace, ImportWorkspace } from "@kbo/persistence";
import { ImportJobManager } from "../../apps/server/src/jobs/import-job-manager.js";

const document = parseStagingGameDocumentV2(
  JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
);
const imported = {
  gameId: document.metadata.gameId,
  revision: 1,
  documentHash: stagingDocumentHash(document),
  projectionHash: "b".repeat(64),
};

describe("적재 의도와 결과의 영속성", () => {
  it("reads the selected import document and target without scanning the full catalog in the worker", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-scoped-"));
    const workspace = await StagingWorkspace.open(directory.path);
    const catalog = vi.spyOn(workspace, "catalog");
    const importRevision = vi.fn(async (_input: unknown) => {
      void _input;
      return imported;
    });
    const manager = new ImportJobManager(workspace, { importRevision });
    try {
      await workspace.saveReady(document, []);
      await workspace.saveSourceFailure("unrelated-failure", [], null);
      const gameId = document.metadata.gameId;
      const expectedTarget = await workspace.readImportTarget(gameId);
      const input = await workspace.readImportInput(gameId);
      expect(input).toEqual({ document, target: expectedTarget });
      if (input?.target.artifact === undefined) throw new Error("Missing test import artifact");
      input.target.artifact.generation += 1;
      expect(await workspace.readImportTarget(gameId)).toEqual(expectedTarget);
      const selection = await manager.createSelection({ gameIds: [gameId] });
      expect(catalog.mock.calls).toEqual([[[gameId]]]);
      expect(selection.count).toBe(1);
      expect((await workspace.imports.selection(selection.selectionId))?.targets).toEqual([
        expectedTarget,
      ]);

      catalog.mockClear();
      const batch = await manager.createReadyBatch({
        selectionId: selection.selectionId,
        idempotencyKey: "one-import",
      });
      expect(batch.jobs.map((job) => job.gameId)).toEqual([gameId]);
      const job = batch.jobs[0];
      if (job === undefined) throw new Error("Missing test import job");
      expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
        status: "succeeded",
        revision: 1,
        documentHash: imported.documentHash,
      });
      expect(importRevision).toHaveBeenCalledExactlyOnceWith(document);
      expect(catalog).not.toHaveBeenCalled();
    } finally {
      await manager.close();
      await workspace.close();
    }
  });

  it("DB 저장 뒤 정리가 진행 중인 작업은 완료 기록과 활동 요약에 함께 남긴다", async () => {
    const cleaning = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const manager = new ImportJobManager(
      {
        catalog: async () => ({ games: [catalogItem(imported.gameId)] }),
        readDocument: async () => document,
        removeImportedStaging: async () => {
          cleaning.resolve(undefined);
          await finish.promise;
        },
      },
      { importRevision: async () => imported },
    );
    const created = await manager.create({
      gameId: imported.gameId,
      idempotencyKey: "in-progress-cleanup",
    });
    await cleaning.promise;
    expect(manager.history({}).activeJobs).toEqual([
      expect.objectContaining({ status: "succeeded", followUpPending: true, error: null }),
    ]);
    expect((await manager.createSelection({})).count).toBe(0);
    finish.resolve(undefined);
    await manager.waitForTerminal(created.jobId);
    expect(manager.history({}).activeJobs).toEqual([]);
    await manager.close();
  });
  it("같은 경기 정리 때문에 보류된 작업을 취소하면 재시작 후에도 적재하지 않는다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-deferred-race-"));
    const workspace = await StagingWorkspace.open(directory.path);
    const journal = vi.spyOn(workspace.imports, "saveJob");
    const holderEntered = Promise.withResolvers<undefined>();
    const gateRelease = Promise.withResolvers<undefined>();
    const cleanupEntered = Promise.withResolvers<undefined>();
    const cleanupRelease = Promise.withResolvers<undefined>();
    const gateQueued = [1, 2].map(() => Promise.withResolvers<undefined>());
    let armed = false;
    let queuedGates = 0;
    let cleanupCalls = 0;
    const source = {
      imports: workspace.imports,
      catalog: async () => ({ games: [catalogItem(imported.gameId)] }),
      readDocument: async () => document,
      withGameOperation<T>(gameId: string, operation: () => Promise<T>) {
        const queued = workspace.withGameOperation(gameId, operation);
        if (armed) gateQueued[queuedGates++]?.resolve(undefined);
        return queued;
      },
      async removeImportedStaging() {
        if (++cleanupCalls === 1) throw new Error("synthetic cleanup failure");
        cleanupEntered.resolve(undefined);
        await cleanupRelease.promise;
      },
    };
    const importRevision = vi.fn(async () => imported);
    const manager = new ImportJobManager(source, { importRevision });
    let recovery: Promise<unknown> | undefined;
    try {
      const first = await manager.create({ gameId: imported.gameId, idempotencyKey: "first-job" });
      expect(await manager.waitForTerminal(first.jobId)).toMatchObject({
        status: "succeeded",
        followUpPending: true,
      });
      const holder = workspace.withGameOperation(imported.gameId, async () => {
        holderEntered.resolve(undefined);
        await gateRelease.promise;
      });
      await holderEntered.promise;
      armed = true;
      const second = await manager.create({
        gameId: imported.gameId,
        idempotencyKey: "second-job",
      });
      await gateQueued[0]?.promise;
      recovery = manager.reconcile(first.jobId);
      await gateQueued[1]?.promise;
      gateRelease.resolve(undefined);
      await holder;
      await cleanupEntered.promise;
      await vi.waitFor(async () => {
        expect(await manager.cancel(second.jobId)).toMatchObject({ status: "cancelled" });
      });
      cleanupRelease.resolve(undefined);
      await recovery;
      await manager.close();
      const restarted = new ImportJobManager(source, { importRevision });
      try {
        await restarted.restore();
        expect(restarted.get(second.jobId).status).toBe("cancelled");
        expect(importRevision).toHaveBeenCalledTimes(1);
        expect(
          journal.mock.calls.filter(
            ([record]) => record.job.jobId === second.jobId && record.job.status === "queued",
          ),
        ).toHaveLength(1);
      } finally {
        await restarted.close();
      }
    } finally {
      gateRelease.resolve(undefined);
      cleanupRelease.resolve(undefined);
      await recovery;
      await manager.close();
      await workspace.close();
    }
  });

  it("배치 취소는 경기 잠금을 기다리는 작업도 적재 전에 취소한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-cancel-gated-"));
    const workspace = await StagingWorkspace.open(directory.path);
    const gateHeld = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const sibling = parseStagingGameDocumentV2({
      ...document,
      metadata: { ...document.metadata, gameId: "unblocked-sibling" },
    });
    const importRevision = vi.fn(async (input: unknown) => {
      const candidate = parseStagingGameDocumentV2(input);
      return {
        ...imported,
        gameId: candidate.metadata.gameId,
        documentHash: stagingDocumentHash(candidate),
      };
    });
    const manager = new ImportJobManager(workspace, { importRevision }, undefined, undefined, 1);
    let closed = false;
    await workspace.saveReady(document, []);
    const holder = workspace.withGameOperation(imported.gameId, async () => {
      gateHeld.resolve(undefined);
      await release.promise;
    });
    try {
      await gateHeld.promise;
      const batch = await manager.createReadyBatch({ idempotencyKey: "cancel-at-game-gate" });
      const job = batch.jobs[0];
      if (job === undefined) throw new Error("missing fixture job");
      expect(manager.get(job.jobId).status).toBe("queued");
      await manager.cancelBatch(batch.batchId);
      expect(manager.get(job.jobId).status).toBe("cancelled");
      await workspace.saveReady(sibling, []);
      const next = await manager.create({
        gameId: sibling.metadata.gameId,
        idempotencyKey: "sibling-while-cancelled-gate-held",
      });
      await vi.waitFor(() => {
        expect(manager.get(next.jobId).status).toBe("succeeded");
      });
      await manager.waitForTerminal(next.jobId);
      const closing = manager.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(closed).toBe(true));
      await closing;
      release.resolve(undefined);
      await holder;
      expect(importRevision).toHaveBeenCalledOnce();
      expect(
        (await workspace.imports.jobs()).find(({ job: saved }) => saved.jobId === job.jobId)?.job
          .status,
      ).toBe("cancelled");
    } finally {
      release.resolve(undefined);
      await holder;
      await manager.close();
      await workspace.close();
    }
  });

  it.each(["자동", "수동"] as const)(
    "한 경기의 후속 재평가가 멈춰도 다른 경기의 %s 봉인 확인을 끝낸다",
    async (mode) => {
      const otherId = "different-game";
      const other = parseStagingGameDocumentV2({
        ...document,
        metadata: { ...document.metadata, gameId: otherId },
      });
      const otherImport = {
        ...imported,
        gameId: otherId,
        documentHash: stagingDocumentHash(other),
      };
      const waiting = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const attempts = new Map<string, number>();
      const cleaned: string[] = [];
      const manager = new ImportJobManager(
        {
          catalog: async () => ({ games: [catalogItem(imported.gameId), catalogItem(otherId)] }),
          removeImportedStaging: async (_season, gameId) => {
            cleaned.push(gameId);
          },
          readDocument: async (_, __, gameId) => (gameId === otherId ? other : document),
          readImportTarget: async (gameId) => ({
            gameId,
            revision: 1,
            season: document.metadata.season,
            documentHash: gameId === otherId ? otherImport.documentHash : imported.documentHash,
            artifact: { generation: 1, contentHash: "c".repeat(64) },
          }),
        },
        {
          importRevision: async () => {
            throw new Error("COMMIT 응답 유실");
          },
          importPublication: async (_, { gameId }) => {
            const count = (attempts.get(gameId) ?? 0) + 1;
            attempts.set(gameId, count);
            if (count === 1) throw new Error("첫 영수증 조회 실패");
            return gameId === otherId ? otherImport : imported;
          },
        },
        undefined,
        undefined,
        1,
        async (gameId) => {
          if (gameId === imported.gameId) {
            waiting.resolve(undefined);
            await release.promise;
          }
        },
      );
      try {
        const first = await manager.create({
          gameId: imported.gameId,
          idempotencyKey: "slow-followup",
        });
        expect(await manager.waitForTerminal(first.jobId)).toMatchObject({
          publicationCheckPending: true,
        });
        const second = await manager.create({
          gameId: otherId,
          idempotencyKey: "other-publication",
        });
        expect(await manager.waitForTerminal(second.jobId)).toMatchObject({
          publicationCheckPending: true,
        });
        await waiting.promise;
        const confirmed = await Promise.race([
          manager.reconcile(first.jobId, "publication"),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        expect(confirmed).toMatchObject({ status: "succeeded", followUpPending: true });
        expect(attempts.get(imported.gameId)).toBe(2);
        if (mode === "수동") {
          const result = await Promise.race([
            manager.reconcile(second.jobId),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
          ]);
          expect(result).toMatchObject({ status: "succeeded", revision: 1 });
        }
        await vi.waitFor(
          () =>
            expect(manager.get(second.jobId)).toMatchObject({ status: "succeeded", revision: 1 }),
          { timeout: 3000 },
        );
        await vi.waitFor(() => expect(cleaned).toEqual([imported.gameId, otherId]));
        expect(manager.get(first.jobId).followUpPending).toBe(true);
        expect(attempts.get(otherId)).toBe(2);
      } finally {
        release.resolve(undefined);
        await manager.close();
      }
    },
    6000,
  );

  it("rejects a queued import when the same document carries a different approval", async () => {
    const starting = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const first = {
      gameId: imported.gameId,
      documentHash: imported.documentHash,
      revision: 1,
      season: document.metadata.season,
      recordCorrection: {
        generation: 1,
        contentHash: "a".repeat(64),
        approvals: [{ noticeId: "2025:0:1", actionSequence: 1 }],
      },
    };
    const importer = vi.fn(async () => imported);
    let target = first;
    const manager = new ImportJobManager(
      {
        catalog: async () => {
          starting.resolve(undefined);
          await resume.promise;
          return { games: [catalogItem(imported.gameId)] };
        },
        readImportTarget: async () => target,
        readDocument: async () => document,
      },
      { importRevision: importer },
    );
    try {
      const job = await manager.create({
        gameId: imported.gameId,
        idempotencyKey: "record-stage",
        expectedDocumentHash: imported.documentHash,
      });
      await starting.promise;
      target = {
        ...first,
        recordCorrection: {
          generation: 2,
          contentHash: "b".repeat(64),
          approvals: [{ noticeId: "2025:0:1", actionSequence: 2 }],
        },
      };
      resume.resolve(undefined);
      expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
        status: "cancelled",
        errorCategory: "domain",
      });
      expect(importer).not.toHaveBeenCalled();
    } finally {
      resume.resolve(undefined);
      await manager.close();
    }
  });

  it("업그레이드 전에 보존한 실제 완료 이력은 재시작 후 조회하되 요청 키를 추측하지 않는다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-retained-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    const old = {
      ...interruptedRecord("old-job", true).job,
      ...imported,
      status: "succeeded" as const,
    };
    await storage.saveRetainedJob(old);
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: [] }),
        readDocument: async () => document,
      },
      { importRevision: vi.fn(async () => imported) },
    );
    await manager.restore();
    expect(manager.history({}).jobs).toEqual([old]);
    expect(manager.get(old.jobId)).toEqual(old);
    expect(await storage.jobs()).toEqual([]);
    await manager.close();
  });
  it("확정 집합에서 제외할 때 새로 생긴 적재 가능 경기는 추가하지 않는다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-selection-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    let ids = ["anon-1", "anon-2"];
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: ids.map(catalogItem) }),
        readDocument: async (_authority, _season, gameId) => ({
          ...document,
          metadata: { ...document.metadata, gameId },
        }),
      },
      { importRevision: vi.fn(async () => imported) },
    );
    const initial = await manager.createSelection({});
    ids = [...ids, "anon-3"];
    const narrowed = await manager.createSelection({
      selectionId: initial.selectionId,
      excludedGameIds: ["anon-1"],
    });
    expect(
      (await storage.selection(narrowed.selectionId))?.targets.map((target) => target.gameId),
    ).toEqual(["anon-2"]);
    await manager.close();
  });
  it("봉인 뒤 이력 저장이 실패하면 확인 대기를 보존하고 재시작에서 성공을 확정한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-io-"));
    let writable = true;
    const storage = new ImportWorkspace(directory.path, async () => {
      if (!writable) throw new Error("disk unavailable");
    });
    const importRevision = vi.fn(async () => {
      writable = false;
      return imported;
    });
    const workspace = {
      imports: storage,
      catalog: async () => ({ games: [catalogItem(imported.gameId)] }),
      readDocument: async () => document,
      readImportTarget: async () => ({
        gameId: imported.gameId,
        revision: imported.revision,
        documentHash: imported.documentHash,
        season: document.metadata.season,
        artifact: { generation: 1, contentHash: "c".repeat(64) },
      }),
      removeImportedStaging: vi.fn(async () => undefined),
    };
    const manager = new ImportJobManager(workspace, {
      importRevision,
      importPublication: async () => imported,
    });
    const job = await manager.create({
      gameId: imported.gameId,
      idempotencyKey: "io-failure-request",
    });
    expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
      status: "running",
      revision: null,
      publicationCheckPending: true,
      error: expect.stringContaining("DB 봉인은 확인됐습니다"),
    });
    expect((await storage.jobs())[0]).toMatchObject({
      publicationPending: true,
      job: { status: "running", revision: null },
    });
    expect(workspace.removeImportedStaging).not.toHaveBeenCalled();
    await expect(
      manager.create({ gameId: imported.gameId, idempotencyKey: "after-failure-request" }),
    ).rejects.toThrow("종료 중");
    await manager.close();
    writable = true;
    const recovered = new ImportJobManager(workspace, {
      importRevision,
      importPublication: async () => imported,
    });
    try {
      await recovered.restore();
      expect(recovered.get(job.jobId)).toMatchObject({
        status: "succeeded",
        revision: 1,
        followUpPending: false,
      });
      expect(importRevision).toHaveBeenCalledTimes(1);
      expect(workspace.removeImportedStaging).toHaveBeenCalledOnce();
    } finally {
      await recovered.close();
    }
  });
  it("응답 전에 확정 집합을 저장하며 재시작 후 같은 요청은 중복 적재하지 않는다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-durable-"));
    const workspace = await StagingWorkspace.open(directory.path);
    try {
      await workspace.saveReady(document, []);
      const importRevision = vi.fn(async () => imported);
      const manager = new ImportJobManager(workspace, { importRevision });
      const selection = await manager.createSelection({ season: document.metadata.season });
      const request = {
        idempotencyKey: "durable-batch-request",
        selectionId: selection.selectionId,
      };
      const [batch, same] = await Promise.all([
        manager.createReadyBatch(request),
        manager.createReadyBatch(request),
      ]);
      expect(same).toEqual(batch);
      expect(await workspace.imports.batches()).toHaveLength(1);
      for (const job of batch.jobs) await manager.waitForTerminal(job.jobId);
      await manager.close();
      const restarted = new ImportJobManager(workspace, { importRevision });
      await restarted.restore();
      expect(await restarted.createReadyBatch(request)).toEqual(batch);
      expect(restarted.history({}).summary.succeeded).toBe(1);
      expect(importRevision).toHaveBeenCalledTimes(1);
      await restarted.close();
    } finally {
      await workspace.close();
    }
  });

  it("선택 뒤 보정된 원장은 건너뛰고 새 문서와 DB base를 보존한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-stale-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    let current = document;
    const importRevision = vi.fn(async () => imported);
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: [catalogItem(document.metadata.gameId)] }),
        readDocument: async () => current,
      },
      { importRevision },
    );
    const selection = await manager.createSelection({});
    current = parseStagingGameDocumentV2({
      ...document,
      metadata: { ...document.metadata, stadium: "보정된 구장" },
    });
    const batch = await manager.createReadyBatch({
      idempotencyKey: "stale-batch-request",
      selectionId: selection.selectionId,
    });
    const job = batch.jobs[0];
    if (job === undefined) throw new Error("missing job");
    expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
      status: "cancelled",
      error: expect.stringContaining("변경"),
    });
    expect(importRevision).not.toHaveBeenCalled();
    expect(current.metadata.stadium).toBe("보정된 구장");
    await manager.close();
  });

  it("DB commit 후 파일 정리 실패는 저장 성공으로 남기고 정리만 재시도한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-cleanup-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error("파일 잠김"))
      .mockResolvedValue(undefined);
    const importRevision = vi.fn(async () => imported);
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: [catalogItem(document.metadata.gameId)] }),
        readDocument: async () => document,
        removeImportedStaging: remove,
      },
      { importRevision },
    );
    const job = await manager.create({
      gameId: document.metadata.gameId,
      idempotencyKey: "cleanup-request",
    });
    expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
      status: "succeeded",
      revision: 1,
      followUpPending: true,
      error: expect.stringContaining("DB 저장 완료"),
    });
    expect(await manager.reconcile(job.jobId)).toMatchObject({
      status: "succeeded",
      followUpPending: false,
      error: null,
    });
    expect(importRevision).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it("강제 중단은 DB manifest와 정확한 hash를 대조하고 미적재 작업은 중단으로 기록한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-recover-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    const committed = interruptedRecord("committed-job", true);
    const pending = interruptedRecord("pending-job", false);
    await storage.saveJob(committed);
    await storage.saveJob(pending);
    const importRevision = vi.fn(async () => imported);
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: [] }),
        readDocument: async () => document,
      },
      {
        importRevision,
        revisions: async () => ({
          gameId: imported.gameId,
          currentRevision: 1,
          revisions: [
            {
              ...imported,
              sealed: true,
              current: true,
              original: true,
              createdAt: committed.job.createdAt,
              sealedAt: committed.job.createdAt,
            },
          ],
        }),
      },
    );
    await manager.restore();
    expect(manager.get("committed-job")).toMatchObject({ status: "succeeded", revision: 1 });
    expect(manager.get("pending-job")).toMatchObject({ status: "cancelled", interrupted: true });
    expect(importRevision).not.toHaveBeenCalled();
    expect(await manager.create(pending.request)).toMatchObject({
      jobId: "pending-job",
      interrupted: true,
    });
    await manager.close();
  });

  it("500개 초과 선택과 페이지·제외를 지원하며 기록 변조를 거부한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-many-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({
          games: Array.from({ length: 503 }, (_, index) => catalogItem(`anon-${String(index)}`)),
        }),
        readDocument: async (_authority, _season, gameId) => ({
          ...document,
          metadata: { ...document.metadata, gameId },
        }),
      },
      {
        importRevision: async () => {
          throw new Error("not executed");
        },
      },
    );
    const selection = await manager.createSelection({ excludedGameIds: ["anon-0", "anon-1"] });
    expect(selection.count).toBe(501);
    expect(
      (await storage.selection(selection.selectionId))?.targets.some(
        (target) => target.gameId === "anon-0",
      ),
    ).toBe(false);
    const filename = path.join(
      directory.path,
      "imports",
      "selections",
      `${selection.selectionId}.json`,
    );
    const text = await readFile(filename, "utf8");
    await writeFile(filename, text.replace('"count":501', '"count":502'));
    await expect(storage.selection(selection.selectionId)).rejects.toThrow("hash");
    await manager.close();
  });
  it("일괄 취소는 진행 중 transaction을 유지하고 모든 대기 경기의 시작을 막는다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-cancel-"));
    const storage = new ImportWorkspace(directory.path, async () => undefined);
    const started = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const importRevision = vi.fn(async () => {
      started.resolve(undefined);
      await finish.promise;
      return imported;
    });
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: ["anon-1", "anon-2", "anon-3"].map(catalogItem) }),
        readDocument: async (_authority, _season, gameId) => ({
          ...document,
          metadata: { ...document.metadata, gameId },
        }),
      },
      { importRevision },
      undefined,
      undefined,
      1,
    );
    const selection = await manager.createSelection({});
    const batch = await manager.createReadyBatch({
      selectionId: selection.selectionId,
      idempotencyKey: "cancel-pending-batch",
    });
    await started.promise;
    const queued = manager.history({ batchId: batch.batchId, limit: 2 });
    expect(queued.summary).toMatchObject({ running: 1, queued: 2 });
    expect(manager.history({ batchId: batch.batchId, limit: 2, view: "activity" })).toEqual(queued);
    await manager.cancelBatch(batch.batchId);
    expect(manager.history({ batchId: batch.batchId }).summary).toMatchObject({
      running: 1,
      cancelled: 2,
      queued: 0,
    });
    const history = manager.history({ batchId: batch.batchId, limit: 2 });
    expect(manager.history({ batchId: batch.batchId, limit: 2, view: "activity" })).toEqual({
      ...history,
      jobs: history.jobs.filter((job) => job.status === "running"),
    });
    expect(
      manager.history({ batchId: batch.batchId, status: "cancelled", view: "activity" }),
    ).toMatchObject({
      jobs: [],
      total: 2,
      activeJobs: [expect.objectContaining({ status: "running" })],
    });
    finish.resolve(undefined);
    for (const job of batch.jobs) await manager.waitForTerminal(job.jobId);
    expect(importRevision).toHaveBeenCalledTimes(1);
    await manager.close();
  });
});
function catalogItem(gameId: string) {
  return {
    gameId,
    season: document.metadata.season,
    authority: "staging" as const,
    updatedAt: "2026-08-21T00:00:00.000Z",
    blockingFindings: 0,
    warningFindings: 0,
    supersededCount: 0,
    gameDate: document.metadata.gameDate,
    teams: document.teams,
  };
}
function interruptedRecord(jobId: string, hasTarget: boolean): ImportJobRecord {
  return {
    request: { gameId: document.metadata.gameId, idempotencyKey: `${jobId}-key` },
    sourceSeason: document.metadata.season,
    target: hasTarget
      ? {
          gameId: imported.gameId,
          documentHash: imported.documentHash,
          revision: 1,
          season: document.metadata.season,
        }
      : null,
    job: {
      jobId,
      gameId: document.metadata.gameId,
      kind: "import",
      status: "running",
      createdAt: "2026-08-21T00:00:00.000Z",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: null,
      revision: null,
      documentHash: null,
      projectionHash: null,
      error: null,
      errorCategory: null,
    },
  };
}
