import { mkdtempDisposable, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { mapNaverGame } from "@kbo/collection";
import { applyCorrectionCommand } from "@kbo/correction";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace } from "@kbo/persistence";

import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("staging workspace", () => {
  it("strict 문서와 finding을 원자 저장하고 catalog에서 읽는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-workspace-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const finding = {
      code: "source.observation",
      category: "source" as const,
      severity: "warning" as const,
      message: "관측 차이",
    };
    await workspace.saveReady(document, [finding]);
    const directory = path.join(temporary.path, "staging", String(document.metadata.season));
    expect((await readdir(directory)).sort()).toEqual([
      `${document.metadata.gameId}.findings.json`,
      `${document.metadata.gameId}.json`,
    ]);
    expect(
      JSON.parse(await readFile(path.join(directory, `${document.metadata.gameId}.json`), "utf8")),
    ).not.toHaveProperty("findings");
    expect(
      JSON.parse(
        await readFile(path.join(directory, `${document.metadata.gameId}.findings.json`), "utf8"),
      ),
    ).toEqual([finding]);
    expect(
      await workspace.readFindings("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual([finding]);
    expect(await workspace.catalog()).toEqual({
      games: [
        expect.objectContaining({
          gameId: document.metadata.gameId,
          authority: "staging",
          warningFindings: 1,
          blockingFindings: 0,
        }),
      ],
    });
    expect(await workspace.readDocument("staging", 2026, document.metadata.gameId)).toEqual(
      document,
    );
    await workspace.close();
  });

  it("finding이 없으면 sidecar를 만들지 않고 기존 sidecar도 제거한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-empty-findings-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await workspace.saveReady(document, [
      {
        code: "source.observation",
        category: "source",
        severity: "warning",
        message: "관측 차이",
      },
    ]);
    await workspace.saveReady(document, []);

    const directory = path.join(temporary.path, "staging", String(document.metadata.season));
    expect(await readdir(directory)).toEqual([`${document.metadata.gameId}.json`]);
    expect((await workspace.catalog()).games[0]).toMatchObject({
      blockingFindings: 0,
      warningFindings: 0,
    });
    await workspace.close();
  });

  it("적재된 hash와 일치할 때만 staging을 제거하고 immutable original은 보존한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-import-cleanup-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await workspace.saveReady(document, []);

    await expect(
      workspace.removeImportedStaging(
        document.metadata.season,
        document.metadata.gameId,
        "0".repeat(64),
      ),
    ).rejects.toThrow("문서 hash가 변경되었습니다");
    expect((await workspace.catalog()).games).toHaveLength(1);

    await workspace.removeImportedStaging(
      document.metadata.season,
      document.metadata.gameId,
      stagingDocumentHash(document),
    );
    expect((await workspace.catalog()).games).toEqual([]);
    expect(
      await workspace.readOriginal(document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    await workspace.close();
  });

  it("첫 수집 문서와 finding을 원본으로 한 번만 저장하고 재수집으로 덮어쓰지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-original-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const originalFinding = {
      code: "source.original",
      category: "source" as const,
      severity: "warning" as const,
      message: "최초 관측",
    };
    await workspace.saveReady(document, [originalFinding]);
    const changed = {
      ...document,
      source: { ...document.source, collectedAt: "2026-08-21T00:00:00.000Z" },
    };
    await workspace.saveReady(changed, []);

    expect(
      await workspace.readOriginal(document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    expect(
      await workspace.readOriginalFindings(document.metadata.season, document.metadata.gameId),
    ).toEqual([originalFinding]);
    expect(
      await workspace.readDocument("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual(changed);
    await workspace.close();
  });

  it("차단 finding이 없는 문서는 quarantine에 저장하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-quarantine-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());

    await expect(
      workspace.saveQuarantine(document, [
        {
          code: "source.observation",
          category: "source",
          severity: "warning",
          message: "관측 차이",
        },
      ]),
    ).rejects.toThrow("차단 finding이 최소 하나 필요합니다");
    expect(await workspace.catalog()).toEqual({ games: [] });
    await workspace.close();
  });

  it("동시에 두 writer가 같은 workspace를 열지 못한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-lock-"));
    const first = await StagingWorkspace.open(temporary.path);
    await expect(StagingWorkspace.open(temporary.path)).rejects.toThrow(/writer process/);
    await first.close();
    const reopened = await StagingWorkspace.open(temporary.path);
    await reopened.close();
  });

  it("strict 문서가 없는 원천 실패도 별도 catalog 항목으로 남긴다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-source-failure-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    await workspace.saveSourceFailure("20260715FAIL", [
      {
        code: "source.endpoint_missing",
        category: "source",
        severity: "blocking",
        message: "record 누락",
      },
    ]);
    expect((await workspace.catalog()).games[0]).toMatchObject({
      gameId: "20260715FAIL",
      season: 2026,
      authority: "source_failure",
      blockingFindings: 1,
    });
    await workspace.close();
  });
  it("재수집이 성공하면 같은 경기의 과거 원천 실패 표시를 제거한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-recovered-source-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await workspace.saveSourceFailure(document.metadata.gameId, [
      {
        code: "source.transport_failed",
        category: "source",
        severity: "blocking",
        message: "일시적 실패",
      },
    ]);
    await workspace.saveReady(document, []);

    expect((await workspace.catalog()).games).toEqual([
      expect.objectContaining({
        gameId: document.metadata.gameId,
        authority: "staging",
      }),
    ]);
    await workspace.close();
  });

  it("API 재시작 시 실행 중 job journal을 중단 실패로 복구하고 정리한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-job-recovery-"));
    const startedAt = "2026-08-20T01:00:00.000Z";
    const first = await StagingWorkspace.open(temporary.path);
    await first.saveCollectionJobJournal({
      jobId: "interrupted-job",
      kind: "collection",
      status: "running",
      createdAt: startedAt,
      startedAt,
      finishedAt: null,
      completedItems: 2,
      totalItems: 5,
      currentGameId: "20260820AABB",
      summary: { ready: 1, quarantined: 1, sourceFailures: 0 },
      error: null,
    });
    await first.close();

    const restarted = await StagingWorkspace.open(
      temporary.path,
      () => new Date("2026-08-20T02:00:00.000Z"),
    );
    expect(await restarted.recoverInterruptedCollectionJobs()).toEqual([
      expect.objectContaining({
        jobId: "interrupted-job",
        status: "failed",
        completedItems: 2,
        currentGameId: null,
        finishedAt: "2026-08-20T02:00:00.000Z",
        error: expect.stringContaining("재시작"),
        errorCategory: "persistence",
      }),
    ]);
    expect(await restarted.recoverInterruptedCollectionJobs()).toEqual([]);
    await restarted.close();
  });

  it("중단된 staging correction journal을 재시작 시 현재 상태로 roll-forward하고 원본만 보존한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-recovery-"),
    );
    const first = await StagingWorkspace.open(
      temporary.path,
      () => new Date("2026-08-20T03:00:00.000Z"),
    );
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await first.saveReady(document, []);
    const movedEvent = document.events[2];
    const targetEvent = document.events[1];
    if (movedEvent === undefined || targetEvent === undefined) {
      throw new Error("fixture correction events missing");
    }
    const command = {
      commandId: "staging-recovery-move",
      kind: "move_event" as const,
      eventId: movedEvent.identity.eventId,
      beforeEventId: targetEvent.identity.eventId,
    };
    const corrected = applyCorrectionCommand(document, command);
    await expect(
      first.commitCorrection(
        {
          baseAuthority: "staging",
          targetAuthority: "staging",
          baseDocumentHash: stagingDocumentHash(document),
          document: corrected.document,
          findings: corrected.replay.findings,
        },
        "after_current",
      ),
    ).rejects.toThrow("injected correction failure");
    await first.close();

    const restarted = await StagingWorkspace.open(temporary.path);
    expect(
      await restarted.readDocument("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual(corrected.document);
    expect(
      (await readdir(path.join(temporary.path, "journals"))).filter((name) =>
        name.startsWith("correction-"),
      ),
    ).toEqual([]);
    expect(
      await restarted.readOriginal(document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    await expect(readdir(path.join(temporary.path, "history"))).rejects.toThrow();
    await restarted.close();
  });

  it("실행 중 빈 catalog 디렉터리가 사라져도 빈 목록으로 처리하고 다음 저장 때 복구한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-missing-catalog-"));
    const workspace = await StagingWorkspace.open(temporary.path);

    await rm(path.join(temporary.path, "staging"), { recursive: true, force: true });
    await rm(path.join(temporary.path, "quarantine"), { recursive: true, force: true });
    expect(await workspace.catalog()).toEqual({ games: [] });

    await workspace.saveSourceFailure("20260715FAIL", [
      {
        code: "source.endpoint_missing",
        category: "source",
        severity: "blocking",
        message: "record 누락",
      },
    ]);
    expect((await workspace.catalog()).games).toEqual([
      expect.objectContaining({
        gameId: "20260715FAIL",
        authority: "source_failure",
      }),
    ]);
    await workspace.close();
  });
});
