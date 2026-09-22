import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PlaywrightScheduleExplorer, mapNaverGame, type CollectedGame } from "@kbo/collection";
import {
  CollectionOverviewSchema,
  CollectionGamePageSchema,
  type CollectionSelectionCreate,
  type CollectionScheduleEntry,
  type GameCatalogItem,
} from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { CollectionOperationsService } from "../../apps/server/src/collection-operations-service.js";
import { CollectionJobManager } from "../../apps/server/src/jobs/collection-job-manager.js";
import {
  collectionInventory,
  collectionCounts,
} from "../../apps/server/src/collection-read-model.js";
import { sanitizedNaverBundle, scheduleGame, schedulePayload } from "../helpers/naver.js";

const range = { startDate: "2025-12-01", endDate: "2026-12-31" };
const timestamp = "2026-09-05T00:00:00.000Z";
function entry(gameId: string, gameDate = "2026-04-01"): CollectionScheduleEntry {
  return {
    gameId,
    gameDate,
    label: "비식별 원정 vs 비식별 홈",
    scheduledAt: `${gameDate}T18:30:00+09:00`,
  };
}
function selection(
  discoveryId: string,
  overrides: Partial<CollectionSelectionCreate> = {},
): CollectionSelectionCreate {
  return {
    discoveryId,
    range,
    target: "uncollected",
    mode: "all_matching",
    gameIds: [],
    excludedGameIds: [],
    ...overrides,
  };
}
function catalog(
  gameId: string,
  authority: "database" | "staging",
  gameDate: string,
): GameCatalogItem {
  const common = {
    gameId,
    season: Number(gameDate.slice(0, 4)),
    gameDate,
    updatedAt: timestamp,
    blockingFindings: 0,
    warningFindings: 0,
    teams: { away: { teamId: "A", name: "비식별 원정" }, home: { teamId: "H", name: "비식별 홈" } },
  };
  return authority === "database"
    ? { ...common, authority, currentRevision: 2, revisionCount: 2 }
    : { ...common, authority, supersededCount: 0 };
}

describe("period collection operations", () => {
  it("이전 수집에서 확인한 실패 경기 날짜는 재시작 뒤 빈 일정에서도 유지한다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-known-collection-game-"));
    const first = await StagingWorkspace.open(temp.path);
    await first.saveSourceFailure("special-failed-game", [], null);
    await first.collection.saveResult("old-job", {
      gameId: "special-failed-game",
      gameDate: "2026-04-02",
      label: "비식별 원정 vs 비식별 홈",
      outcome: "source_failure",
      message: "원천 응답 실패",
      finishedAt: timestamp,
    });
    await first.close();
    const workspace = await StagingWorkspace.open(temp.path);
    const service = new CollectionOperationsService(
      { discoverRange: async () => [] },
      workspace,
      async () => ({ games: [] }),
    );
    try {
      const discovery = await service.create({ ...range, idempotencyKey: "empty-new-schedule" });
      await service.wait(discovery.discoveryId);
      const overview = await service.overview(discovery.discoveryId, {});
      expect(overview.unknownDateCount).toBe(0);
      expect(overview.counts).toMatchObject({ total: 1, source_failure: 1, uncollected: 0 });
      expect((await service.games(discovery.discoveryId, {})).games[0]).toMatchObject({
        gameId: "special-failed-game",
        gameDate: "2026-04-02",
        state: "source_failure",
      });
    } finally {
      await service.close();
      await workspace.close();
    }
  });
  it("500경기를 넘는 확정 집합을 한 작업으로 접수하고 변경된 DB base는 수집 없이 건너뛴다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-selection-large-job-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const service = new CollectionOperationsService(
      {
        discoverRange: async () =>
          Array.from({ length: 501 }, (_, index) => entry(`large-${index}`)),
      },
      workspace,
      async () => ({ games: [] }),
    );
    const collect = vi.fn(async (): Promise<CollectedGame> => {
      throw new Error("DB 저장 경기 수집 금지");
    });
    const manager = new CollectionJobManager(
      { discoverRange: async () => [] },
      { collect },
      workspace,
      1,
      undefined,
      undefined,
      async () => ({ revision: 1, documentHash: "a".repeat(64), sourceBundleHash: "b".repeat(64) }),
    );
    try {
      const discovery = await service.create({ ...range, idempotencyKey: "large-job-discovery" });
      await service.wait(discovery.discoveryId);
      const selected = await service.select(selection(discovery.discoveryId));
      const request = {
        scope: { kind: "selection" as const, selectionId: selected.selectionId },
        idempotencyKey: "large-job-key",
      };
      const [one, two] = await Promise.all([manager.create(request), manager.create(request)]);
      expect(one.jobId).toBe(two.jobId);
      expect(one.totalItems).toBe(501);
      expect(await manager.waitForTerminal(one.jobId)).toMatchObject({
        status: "succeeded",
        completedItems: 501,
        skippedItems: 501,
      });
      expect(collect).not.toHaveBeenCalled();
      expect(await workspace.collection.results(one.jobId)).toHaveLength(501);
    } finally {
      await manager.close();
      await service.close();
      await workspace.close();
    }
  }, 20_000);

  it("일정 취소와 queued 복구는 완전한 빈 일정으로 오해되지 않는다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-discovery-cancel-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const entered = Promise.withResolvers<undefined>();
    const service = new CollectionOperationsService(
      {
        discoverRange: async (_start, _end, signal) => {
          entered.resolve(undefined);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return [];
        },
      },
      workspace,
      async () => ({ games: [] }),
    );
    try {
      const created = await service.create({ ...range, idempotencyKey: "cancel-discovery" });
      await entered.promise;
      expect(await service.cancel(created.discoveryId)).toMatchObject({
        complete: false,
        status: "cancelled",
      });
      expect((await service.overview(created.discoveryId, {})).counts.uncollected).toBeNull();
      await workspace.collection.saveDiscovery({
        discovery: { ...created, discoveryId: "queued-discovery", status: "queued" },
        idempotencyKey: "queued-discovery",
      });
      await service.restore();
      expect(await service.get("queued-discovery")).toMatchObject({
        status: "failed",
        complete: false,
      });
    } finally {
      await service.close();
      await workspace.close();
    }
  });

  it("파일 저장 경계는 같은 경기의 DB 적재가 끝난 뒤 base를 다시 확인한다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-operation-gate-"));
    const workspace = await StagingWorkspace.open(temp.path);
    try {
      const entered = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>();
      let revision = 0;
      const importing = workspace.withGameOperation("same-game", async () => {
        entered.resolve(undefined);
        await release.promise;
        revision = 1;
      });
      await entered.promise;
      const checked = vi.fn(async () => revision);
      const storing = workspace.withGameOperation("same-game", checked);
      await workspace.withGameOperation("other-game", async () =>
        expect(checked).not.toHaveBeenCalled(),
      );
      release.resolve(undefined);
      await importing;
      expect(await storing).toBe(1);
    } finally {
      await workspace.close();
    }
  });
  it("작업본과 DB를 한 경기로 집계하고 특수 ID와 날짜 미확인 실패를 추측하지 않는다", () => {
    const games = collectionInventory(
      [entry("special-game", "2026-04-01"), entry("missing")],
      [
        catalog("special-game", "staging", "2026-04-02"),
        {
          gameId: "19990101UNKNOWN",
          authority: "source_failure",
          season: null,
          updatedAt: timestamp,
          blockingFindings: 1,
          warningFindings: 0,
          supersededCount: 0,
        },
      ],
      [
        catalog("special-game", "database", "2026-04-02"),
        catalog("held-only", "database", "2025-12-31"),
      ],
    );
    expect(games).toHaveLength(4);
    expect(games.find((game) => game.gameId === "special-game")).toMatchObject({
      state: "staging",
      databaseRevision: 2,
      gameDate: "2026-04-02",
    });
    expect(games.find((game) => game.gameId === "19990101UNKNOWN")?.gameDate).toBeNull();
    expect(
      collectionCounts(
        games.filter((game) => game.gameDate !== null),
        true,
      ),
    ).toEqual({
      total: 3,
      uncollected: 1,
      staging: 1,
      quarantine: 0,
      source_failure: 0,
      database: 2,
    });
  });

  it("일정 원문 hash와 부분 응답을 보존하고 미확인 수는 null로 표시한다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-discovery-partial-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const explorer = new PlaywrightScheduleExplorer(async (_start, _end, page) => ({
      status: page === 1 ? 200 : 503,
      url: `https://source.invalid/schedule?page=${page}`,
      payload:
        page === 1
          ? schedulePayload([scheduleGame("anon", "2026-04-01")], 2)
          : { message: "unavailable" },
    }));
    const service = new CollectionOperationsService(explorer, workspace, async () => ({
      games: [],
    }));
    try {
      const created = await service.create({ ...range, idempotencyKey: "partial-range" });
      expect(await service.wait(created.discoveryId)).toMatchObject({
        status: "failed",
        complete: false,
        pageCount: 2,
        gameCount: 1,
      });
      const overview = await service.overview(created.discoveryId, {});
      expect(Value.Check(CollectionOverviewSchema, overview)).toBe(true);
      expect(overview.counts).toMatchObject({ total: 1, uncollected: null });
      expect((await workspace.collection.page(created.discoveryId, 2))?.status).toBe(503);
      await expect(service.select(selection(created.discoveryId))).rejects.toThrow("전체 확인");
      expect(
        (await service.create({ ...range, idempotencyKey: "partial-range" })).discoveryId,
      ).toBe(created.discoveryId);
      const filename = path.join(
        temp.path,
        "collection",
        "discoveries",
        created.discoveryId,
        "entries.json",
      );
      await writeFile(filename, (await readFile(filename, "utf8")).replace("anon", "tampered"));
      await expect(service.games(created.discoveryId, {})).rejects.toThrow("hash");
    } finally {
      await service.close();
      await workspace.close();
    }
  });

  it("10,000경기를 원장 조회 없이 집계·검색·페이지 처리하고 연도/월/날짜 합계를 맞춘다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-discovery-large-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      entry(
        `anon-${index}`,
        index < 300 ? "2025-12-31" : index < 8_000 ? "2026-04-01" : "2026-05-01",
      ),
    );
    const service = new CollectionOperationsService(
      { discoverRange: async () => entries },
      workspace,
      async () => ({ games: [] }),
    );
    const read = vi
      .spyOn(workspace, "readDocument")
      .mockRejectedValue(new Error("전체 원장 조회 금지"));
    try {
      const created = await service.create({ ...range, idempotencyKey: "large-range" });
      await service.wait(created.discoveryId);
      const overview = await service.overview(created.discoveryId, { groupBy: "month" });
      expect(overview.groups.reduce((sum, group) => sum + group.counts.total, 0)).toBe(10_000);
      expect(overview.groups.find((group) => group.key === "2025-12")?.counts.total).toBe(300);
      const days = await service.overview(created.discoveryId, {
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        groupBy: "day",
      });
      expect(days.groups.reduce((sum, group) => sum + group.counts.total, 0)).toBe(7_700);
      const first = await service.games(created.discoveryId, { page: 1 });
      const second = await service.games(created.discoveryId, { page: 2 });
      expect(Value.Check(CollectionGamePageSchema, first)).toBe(true);
      expect(first.games).toHaveLength(50);
      expect(second.games).toHaveLength(50);
      expect(new Set([...first.games, ...second.games].map((game) => game.gameId)).size).toBe(100);
      expect((await service.games(created.discoveryId, { search: "anon-9999" })).total).toBe(1);
      expect(JSON.stringify(first).length).toBeLessThan(25_000);
      expect(read).not.toHaveBeenCalled();
      await expect(service.games(created.discoveryId, { limit: 201 })).rejects.toThrow("200");
      const confirmed = await service.select(
        selection(created.discoveryId, {
          range: { startDate: "2025-12-31", endDate: "2026-04-01" },
          excludedGameIds: ["anon-1", "anon-7999"],
        }),
      );
      expect(confirmed.count).toBe(7_998);
      const explicit = await service.select(
        selection(created.discoveryId, { mode: "explicit", gameIds: ["anon-1", "anon-9999"] }),
      );
      expect(explicit.count).toBe(2);
    } finally {
      await service.close();
      await workspace.close();
    }
  }, 20_000);

  it("확정 후 DB 변경은 건너뛰고 수집 도중 생성된 수동 작업본은 저장 경계에서 보존한다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-selection-race-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const bundle = await sanitizedNaverBundle();
    const { document } = mapNaverGame(bundle);
    const service = new CollectionOperationsService(
      { discoverRange: async () => [entry(bundle.gameId, document.metadata.gameDate)] },
      workspace,
      async () => ({ games: [] }),
    );
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collecting = Promise.withResolvers<undefined>();
    const collect = vi.fn(async (): Promise<CollectedGame> => {
      collecting.resolve(undefined);
      await gate;
      return { gameId: bundle.gameId, disposition: "collected", bundle, findings: [] };
    });
    const manager = new CollectionJobManager(
      { discoverRange: async () => [] },
      { collect },
      workspace,
    );
    try {
      const discovery = await service.create({ ...range, idempotencyKey: "race-range" });
      await service.wait(discovery.discoveryId);
      const selected = await service.select(selection(discovery.discoveryId));
      const job = await manager.create({
        scope: { kind: "selection", selectionId: selected.selectionId },
        idempotencyKey: "race-collection",
      });
      await collecting.promise;
      const manual = structuredClone(document);
      const event = manual.events[0];
      if (event === undefined) throw new Error("fixture event 누락");
      event.relayText = "비식별 수동 보정 유지";
      await workspace.saveReady(manual, []);
      const token = await workspace.collectionToken(bundle.gameId);
      release?.();
      expect(await manager.waitForTerminal(job.jobId)).toMatchObject({
        status: "succeeded",
        skippedItems: 1,
      });
      expect(await workspace.collectionToken(bundle.gameId)).toBe(token);
      expect(
        (await workspace.readDocument("staging", manual.metadata.season, bundle.gameId)).events[0]
          ?.relayText,
      ).toBe("비식별 수동 보정 유지");
      expect((await workspace.collection.results(job.jobId))[0]).toMatchObject({
        outcome: "skipped",
        message: expect.stringContaining("작업본"),
      });
      await manager.close();
      const restored = new CollectionJobManager(
        { discoverRange: async () => [] },
        { collect },
        workspace,
      );
      await restored.restoreInterrupted();
      expect(
        (
          await restored.create({
            scope: { kind: "selection", selectionId: selected.selectionId },
            idempotencyKey: "race-collection",
          })
        ).jobId,
      ).toBe(job.jobId);
      expect(collect).toHaveBeenCalledOnce();
      await restored.close();
    } finally {
      release?.();
      await manager.close();
      await service.close();
      await workspace.close();
    }
  });

  it("강제 중단된 queued/running 이력의 요청 키·완료 결과·SSE 순서를 복구한다", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-collection-restart-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const service = new CollectionOperationsService(
      { discoverRange: async () => [entry("one"), entry("two")] },
      workspace,
      async () => ({ games: [] }),
    );
    try {
      const discovery = await service.create({ ...range, idempotencyKey: "restart-range" });
      await service.wait(discovery.discoveryId);
      const selected = await service.select(selection(discovery.discoveryId));
      const record = await workspace.collection.selection(selected.selectionId);
      if (record === null) throw new Error("selection 누락");
      const request = {
        scope: { kind: "selection" as const, selectionId: selected.selectionId },
        idempotencyKey: "restart-request",
      };
      await workspace.collection.saveTargets("interrupted-job", record.entries);
      await workspace.collection.saveHistory({
        job: {
          jobId: "interrupted-job",
          kind: "collection",
          scope: request.scope,
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          completedItems: 0,
          skippedItems: 0,
          totalItems: 2,
          currentGameId: "one",
          summary: { ready: 0, quarantined: 0, sourceFailures: 0 },
          error: null,
          errorCategory: null,
        },
        request,
        sequence: 12,
        range,
      });
      await workspace.collection.saveResult("interrupted-job", {
        gameId: "one",
        gameDate: "2026-04-01",
        label: "완료 경기",
        outcome: "ready",
        message: "완료",
        finishedAt: timestamp,
      });
      const collect = vi.fn(async (): Promise<CollectedGame> => {
        throw new Error("자동 재실행 금지");
      });
      const manager = new CollectionJobManager(
        { discoverRange: async () => [] },
        { collect },
        workspace,
      );
      await manager.restoreInterrupted();
      expect(manager.get("interrupted-job")).toMatchObject({
        status: "failed",
        completedItems: 1,
        summary: { ready: 1 },
      });
      expect(
        (await workspace.collection.results("interrupted-job")).map((item) => item.outcome).sort(),
      ).toEqual(["interrupted", "ready"]);
      expect(manager.eventsAfter("interrupted-job", "interrupted-job:12")[0]?.sequence).toBe(13);
      expect((await manager.create(request)).jobId).toBe("interrupted-job");
      expect(collect).not.toHaveBeenCalled();
      expect((await service.historyItems("interrupted-job", 1, 50, true)).total).toBe(1);
      await manager.close();
    } finally {
      await service.close();
      await workspace.close();
    }
  });
});
