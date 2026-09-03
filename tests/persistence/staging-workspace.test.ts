import { createHash } from "node:crypto";
import { copyFile, mkdtempDisposable, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { mapNaverGame } from "@kbo/collection";
import { canonicalStringify, parseCurrentWorkspaceEntry } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { stagingDocumentHash } from "@kbo/game-core";
import { StagingWorkspace, WorkspacePersistenceBlockedError } from "@kbo/persistence";

import { sanitizedNaverBundle } from "../helpers/naver.js";

describe("staging workspace", () => {
  it("strict 문서와 finding을 원자 저장하고 catalog에서 읽는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-workspace-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    const finding = {
      producer: "collection" as const,
      lifecycle: "persistent" as const,
      code: "source.observation",
      category: "source" as const,
      severity: "warning" as const,
      message: "관측 차이",
    };
    await workspace.saveReady(document, [finding]);
    const current = parseCurrentWorkspaceEntry(
      JSON.parse(
        await readFile(
          path.join(temporary.path, "current", `${document.metadata.gameId}.json`),
          "utf8",
        ),
      ) as unknown,
    );
    expect(current).toMatchObject({
      gameId: document.metadata.gameId,
      authority: "ready",
      generation: 1,
    });
    const artifact = path.join(temporary.path, ...current.artifactPath.split("/"));
    expect(JSON.parse(await readFile(artifact, "utf8"))).not.toHaveProperty("findings");
    expect(
      JSON.parse(await readFile(artifact.replace(".document.json", ".findings.json"), "utf8")),
    ).toEqual({ schemaVersion: 2, findings: [finding] });
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
    await expect(workspace.readCurrentDocumentSnapshot(document.metadata.gameId)).resolves.toEqual({
      authority: "staging",
      season: document.metadata.season,
      document,
      findings: [finding],
    });
    await workspace.close();
  });

  it("동일 canonical source는 gzip 압축 바이트가 달라도 immutable 재전송으로 인정한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-source-gzip-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const gameId = "20260715GZIP";
    const payloads = { preview: { status: "final", score: 1 } };
    const sourceBundleHash = createHash("sha256")
      .update(canonicalStringify({ gameId, missingEndpoints: [], payloads }), "utf8")
      .digest("hex");
    const bundle = {
      gameId,
      season: 2026,
      collectedAt: "2026-07-15T00:00:00.000Z",
      sourceBundleHash,
      payloads,
      missingEndpoints: [],
    };
    await workspace.saveSourceBundle(bundle);
    const target = path.join(
      temporary.path,
      "source",
      "2026",
      gameId,
      sourceBundleHash,
      "preview.json.gz",
    );
    const canonical = gunzipSync(await readFile(target));
    await writeFile(target, gzipSync(canonical, { level: 1 }));

    await expect(workspace.saveSourceBundle(bundle)).resolves.toBeUndefined();
    await workspace.close();
  });

  it("finding이 없으면 sidecar를 만들지 않고 기존 sidecar도 제거한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-empty-findings-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await workspace.saveReady(document, [
      {
        producer: "collection",
        lifecycle: "persistent",
        code: "source.observation",
        category: "source",
        severity: "warning",
        message: "관측 차이",
      },
    ]);
    await workspace.saveReady(document, []);

    const active = path.join(temporary.path, "active", document.metadata.gameId);
    expect(await readdir(active)).toEqual([
      expect.stringMatching(/^2-[0-9a-f]{64}\.document\.json$/),
    ]);
    expect((await workspace.catalog()).games[0]).toMatchObject({
      blockingFindings: 0,
      warningFindings: 0,
      supersededCount: 1,
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
      producer: "collection" as const,
      lifecycle: "persistent" as const,
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
          producer: "collection",
          lifecycle: "persistent",
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
        producer: "collection",
        lifecycle: "persistent",
        code: "source.endpoint_missing",
        category: "source",
        severity: "blocking",
        message: "record 누락",
      },
    ]);
    expect((await workspace.catalog()).games[0]).toMatchObject({
      gameId: "20260715FAIL",
      season: null,
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
        producer: "collection",
        lifecycle: "persistent",
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
        supersededCount: 1,
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
      errorCategory: null,
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
    const player = document.rosters.away.players[0];
    if (player === undefined) {
      throw new Error("fixture correction roster missing");
    }
    const command = {
      commandId: "staging-recovery-roster-position",
      kind: "update_roster_position" as const,
      side: "away" as const,
      playerId: player.playerId,
      positions: [...player.positions, "대체"],
    };
    const corrected = applyCorrectionCommand(document, command);
    await expect(
      first.commitCorrection(
        {
          baseAuthority: "staging",
          targetAuthority: "staging",
          baseDocumentHash: stagingDocumentHash(document),
          document: corrected.document,
          findingEnvelope: {
            schemaVersion: 2,
            findings: corrected.replay.findings.map((finding) => ({
              ...finding,
              producer: "compiler" as const,
              lifecycle: "recomputed" as const,
            })),
          },
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
        producer: "collection",
        lifecycle: "persistent",
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

  it("중단된 workspace transition journal을 startup에서 결정론적으로 roll-forward한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-transition-recovery-"),
    );
    const first = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await first.saveReady(document, []);
    const currentPath = path.join(temporary.path, "current", `${document.metadata.gameId}.json`);
    const previous = parseCurrentWorkspaceEntry(JSON.parse(await readFile(currentPath, "utf8")));
    const player = document.rosters.away.players[0];
    if (player === undefined) throw new Error("transition fixture player가 없습니다.");
    const changed = applyCorrectionCommand(document, {
      commandId: "transition-recovery-change",
      kind: "update_roster_position",
      side: "away",
      playerId: player.playerId,
      positions: [...player.positions, "복구"],
    }).document;
    const envelope = { schemaVersion: 2 as const, findings: [] };
    const contentHash = createHash("sha256")
      .update(canonicalStringify({ document: changed, findingEnvelope: envelope }), "utf8")
      .digest("hex");
    const artifactPath = `active/${document.metadata.gameId}/2-${contentHash}.document.json`;
    await writeFile(
      path.join(temporary.path, ...artifactPath.split("/")),
      `${canonicalStringify(changed)}\n`,
    );
    const target = {
      schemaVersion: 1 as const,
      gameId: document.metadata.gameId,
      season: document.metadata.season,
      authority: "ready" as const,
      generation: 2,
      updatedAt: "2026-08-20T04:00:00.000Z",
      artifactPath,
      contentHash,
      documentHash: stagingDocumentHash(changed),
    };
    await writeFile(
      path.join(
        temporary.path,
        "journals",
        `workspace-${document.metadata.gameId}-test-transition.json`,
      ),
      `${canonicalStringify({
        schemaVersion: 1,
        transitionId: "test-transition",
        gameId: document.metadata.gameId,
        previous,
        target,
        createdAt: "2026-08-20T04:00:00.000Z",
      })}\n`,
    );
    await first.close();

    const restarted = await StagingWorkspace.open(temporary.path);
    expect(
      await restarted.readDocument("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual(changed);
    expect(
      (await readdir(path.join(temporary.path, "journals"))).filter((name) =>
        name.startsWith("workspace-"),
      ),
    ).toEqual([]);
    await restarted.close();
  });

  it("journal 없는 orphan active artifact를 startup에서 persistence-blocked로 거부한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-orphan-active-"));
    const first = await StagingWorkspace.open(temporary.path);
    const { document } = mapNaverGame(await sanitizedNaverBundle());
    await first.saveReady(document, []);
    const current = parseCurrentWorkspaceEntry(
      JSON.parse(
        await readFile(
          path.join(temporary.path, "current", `${document.metadata.gameId}.json`),
          "utf8",
        ),
      ),
    );
    const orphan = path.join(
      temporary.path,
      "active",
      document.metadata.gameId,
      `2-${"a".repeat(64)}.document.json`,
    );
    await copyFile(path.join(temporary.path, ...current.artifactPath.split("/")), orphan);
    await first.close();

    await expect(StagingWorkspace.open(temporary.path)).rejects.toThrow(
      WorkspacePersistenceBlockedError,
    );
  });
});
