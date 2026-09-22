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
  it("이력 저장 실패는 처리되지 않은 promise 오류 없이 새 DB 작업을 중단한다", async () => {
    await using directory = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-io-"));
    let writable = true;
    const storage = new ImportWorkspace(directory.path, async () => {
      if (!writable) throw new Error("disk unavailable");
    });
    const importRevision = vi.fn(async () => {
      writable = false;
      return imported;
    });
    const manager = new ImportJobManager(
      {
        imports: storage,
        catalog: async () => ({ games: [catalogItem(imported.gameId)] }),
        readDocument: async () => document,
      },
      { importRevision },
    );
    const job = await manager.create({
      gameId: imported.gameId,
      idempotencyKey: "io-failure-request",
    });
    expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
      status: "succeeded",
      revision: 1,
      followUpPending: true,
      error: expect.stringContaining("이력 저장 실패"),
    });
    await expect(
      manager.create({ gameId: imported.gameId, idempotencyKey: "after-failure-request" }),
    ).rejects.toThrow("종료 중");
    await manager.close();
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
    await manager.cancelBatch(batch.batchId);
    expect(manager.history({ batchId: batch.batchId }).summary).toMatchObject({
      running: 1,
      cancelled: 2,
      queued: 0,
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
