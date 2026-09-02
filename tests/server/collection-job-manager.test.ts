import { access, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CollectionCancelledError,
  NaverTransportError,
  mapNaverGame,
  type CollectedGame,
  type RawGameBundle,
  type ScheduleEntry,
} from "@kbo/collection";
import { StagingWorkspace } from "@kbo/persistence";

import {
  CollectionJobManager,
  IdempotencyConflictError,
  InvalidCollectionRequestError,
} from "../../apps/server/src/jobs/collection-job-manager.js";
import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("CollectionJobManager", () => {
  it("idempotency와 단조 증가 event를 지키며 ready 문서를 저장한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = await sanitizedNaverBundle();
    const manager = managerFor(workspace, bundle);
    const request = {
      scope: { kind: "game_ids" as const, gameIds: [bundle.gameId] },
      idempotencyKey: "same-request-key",
    };
    const created = manager.create(request);
    expect(manager.create(request).jobId).toBe(created.jobId);
    expect(() =>
      manager.create({
        scope: { kind: "game_ids", gameIds: ["OTHER"] },
        idempotencyKey: "same-request-key",
      }),
    ).toThrow(IdempotencyConflictError);

    const completed = await manager.waitForTerminal(created.jobId);
    expect(completed).toMatchObject({
      status: "succeeded",
      completedItems: 1,
      summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
    });
    const events = manager.eventsAfter(created.jobId, undefined);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(manager.eventsAfter(created.jobId, events[1]?.eventId).at(0)?.sequence).toBe(3);
    expect((await workspace.catalog()).games[0]?.authority).toBe("staging");
    await manager.close();
    await workspace.close();
  });

  it("source bundle을 특수경기 ID 접두사가 아닌 preview 시즌 아래 저장한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-season-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = {
      ...structuredClone(await sanitizedNaverBundle()),
      gameId: "33331005AABB02026",
    };
    const manager = managerFor(workspace, bundle);
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: [bundle.gameId] },
      idempotencyKey: "special-game-source-season",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "succeeded",
      completedItems: 1,
    });
    await expect(
      access(path.join(temporary.path, "source", "2026", bundle.gameId)),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(temporary.path, "source", "3333", bundle.gameId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await manager.close();
    await workspace.close();
  });

  it("이미 staging에 있는 경기는 외부 수집 없이 완료 처리한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-skip-ready-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = await sanitizedNaverBundle();
    const { document } = mapNaverGame(bundle);
    const secondGameId = `${bundle.gameId}R`;
    const secondDocument = {
      ...document,
      source: { ...document.source, sourceGameId: secondGameId },
      metadata: { ...document.metadata, gameId: secondGameId },
    };
    await workspace.saveReady(document, []);
    await workspace.saveReady(secondDocument, []);
    const before = await workspace.readDocument("staging", document.metadata.season, bundle.gameId);
    const collectedGameIds: string[] = [];
    const manager = new CollectionJobManager(
      { discoverRange: async () => [] },
      {
        async collect(gameId): Promise<CollectedGame> {
          collectedGameIds.push(gameId);
          throw new Error("staging 경기를 다시 수집하면 안 됩니다.");
        },
      },
      workspace,
    );
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: [bundle.gameId, secondGameId] },
      idempotencyKey: "skip-ready-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "succeeded",
      completedItems: 2,
      totalItems: 2,
      summary: { ready: 0, quarantined: 0, sourceFailures: 0 },
    });
    expect(collectedGameIds).toEqual([]);
    expect(
      await workspace.readDocument("staging", document.metadata.season, bundle.gameId),
    ).toEqual(before);
    const events = manager.eventsAfter(job.jobId, undefined);
    expect(events.filter((event) => event.type === "game_completed")).toEqual([]);
    expect(
      events.filter((event) => event.payload.message.includes("재수집을 건너뛰었습니다")),
    ).toEqual([
      expect.objectContaining({
        type: "progress",
        payload: expect.objectContaining({
          gameId: null,
          disposition: "none",
          completedItems: 2,
          message: expect.stringContaining("2경기"),
        }),
      }),
    ]);
    await manager.close();
    await workspace.close();
  });

  it("quarantine에 있는 경기는 다시 수집해 staging으로 승격할 수 있다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-job-recollect-quarantine-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = await sanitizedNaverBundle();
    const { document } = mapNaverGame(bundle);
    await workspace.saveQuarantine(document, [
      {
        code: "source.needs_review",
        category: "source",
        severity: "blocking",
        message: "재수집이 필요한 검토 항목",
      },
    ]);
    const collectedGameIds: string[] = [];
    const manager = new CollectionJobManager(
      { discoverRange: async () => [] },
      {
        async collect(gameId): Promise<CollectedGame> {
          collectedGameIds.push(gameId);
          return { gameId, disposition: "collected", bundle, findings: [] };
        },
      },
      workspace,
    );
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: [bundle.gameId] },
      idempotencyKey: "recollect-quarantine-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "succeeded",
      completedItems: 1,
      summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
    });
    expect(collectedGameIds).toEqual([bundle.gameId]);
    expect((await workspace.catalog()).games).toEqual([
      expect.objectContaining({ gameId: bundle.gameId, authority: "staging" }),
    ]);
    await manager.close();
    await workspace.close();
  });

  it("이벤트 계산과 공식 기록이 다르면 Python 기준대로 quarantine에 저장한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-record-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = structuredClone(await sanitizedNaverBundle());
    Object.assign(officialBatter(bundle), { ab: 7, hit: 6, hr: 3 });
    const manager = managerFor(workspace, bundle);
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: [bundle.gameId] },
      idempotencyKey: "record-mismatch-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "succeeded",
      summary: { ready: 0, quarantined: 1, sourceFailures: 0 },
    });
    expect((await workspace.catalog()).games[0]).toMatchObject({
      gameId: bundle.gameId,
      authority: "quarantine",
    });
    await manager.close();
    await workspace.close();
  });

  it("공식 RBI가 compiler 계산과 다르면 quarantine에 저장한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-rbi-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const bundle = structuredClone(await sanitizedNaverBundle());
    officialBatter(bundle).rbi = 4;
    const manager = managerFor(workspace, bundle);
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: [bundle.gameId] },
      idempotencyKey: "rbi-excluded-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "succeeded",
      summary: { ready: 0, quarantined: 1, sourceFailures: 0 },
    });
    expect((await workspace.catalog()).games[0]?.authority).toBe("quarantine");
    await manager.close();
    await workspace.close();
  });

  it("명시적 취소가 현재 작업의 AbortSignal까지 전달된다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-cancel-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const collector = {
      collect(_gameId: string, signal: AbortSignal): Promise<CollectedGame> {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new CollectionCancelledError()), {
            once: true,
          });
        });
      },
    };
    const manager = new CollectionJobManager(
      { discoverRange: async () => [] },
      collector,
      workspace,
      1,
    );
    const job = manager.create({
      scope: { kind: "game_ids", gameIds: ["G1"] },
      idempotencyKey: "cancel-request-key",
    });
    while (manager.get(job.jobId).status === "queued") {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(manager.cancel(job.jobId).status).toBe("cancelling");
    expect((await manager.waitForTerminal(job.jobId)).status).toBe("cancelled");
    await manager.close();
    await workspace.close();
  });
  it("실제 달력에 없거나 역전된 날짜 범위를 job 생성 전에 거부한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-date-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const manager = managerFor(workspace, await sanitizedNaverBundle());

    expect(() =>
      manager.create({
        scope: { kind: "date_range", startDate: "2026-02-30", endDate: "2026-03-01" },
        idempotencyKey: "invalid-calendar-date",
      }),
    ).toThrow(InvalidCollectionRequestError);
    expect(() =>
      manager.create({
        scope: { kind: "date_range", startDate: "2026-04-02", endDate: "2026-04-01" },
        idempotencyKey: "reversed-date-range",
      }),
    ).toThrow(InvalidCollectionRequestError);

    await manager.close();
    await workspace.close();
  });

  it("일정 탐색 전송 실패는 source 범주로 남긴다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-source-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const manager = new CollectionJobManager(
      {
        discoverRange: async () => Promise.reject(new NaverTransportError("일정 요청 실패")),
      },
      { collect: async () => Promise.reject(new Error("unexpected collect")) },
      workspace,
    );
    const job = manager.create({
      scope: { kind: "date_range", startDate: "2026-08-01", endDate: "2026-08-01" },
      idempotencyKey: "source-failure-key",
    });

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      status: "failed",
      error: "일정 요청 실패",
      errorCategory: "source",
    });
    await manager.close();
    await workspace.close();
  });
});

function managerFor(workspace: StagingWorkspace, bundle: RawGameBundle): CollectionJobManager {
  const explorer = {
    async discoverRange(): Promise<readonly ScheduleEntry[]> {
      return [];
    },
  };
  const collector = {
    async collect(): Promise<CollectedGame> {
      return {
        gameId: bundle.gameId,
        disposition: "collected",
        bundle,
        findings: [],
      };
    },
  };
  return new CollectionJobManager(explorer, collector, workspace, 1);
}

function officialBatter(bundle: RawGameBundle): Record<string, unknown> {
  const record = bundle.payloads.record as {
    batter: { away: Array<Record<string, unknown>> };
  };
  const batter = record.batter.away[0];
  if (batter === undefined) throw new Error("테스트 fixture에 타자 기록이 없습니다.");
  return batter;
}
