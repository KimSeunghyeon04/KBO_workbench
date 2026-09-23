import { mkdtempDisposable, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash, type Finding } from "@kbo/game-core";
import { StagingWorkspace, type StoredFinding } from "@kbo/persistence";
import { describe, expect, it, vi } from "vitest";

import {
  CorrectionCommitBlockedError,
  CorrectionSessionManager,
  CorrectionSessionLimitError,
  CorrectionSessionNotFoundError,
  StaleCorrectionSessionError,
} from "../../apps/server/src/correction-session-manager.js";
import { inlineComputation, type ComputationRunner } from "../../apps/server/src/computation.js";

describe("CorrectionSessionManager", () => {
  it("an incomplete worker snapshot cannot advance the document, version or undo stack", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-snapshot-failure-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    const manager = new CorrectionSessionManager(workspace, undefined, undefined, undefined, {
      async run(input) {
        if (input.kind === "command")
          return { kind: "command", value: applyCorrectionCommand(input.document, input.command) };
        return inlineComputation.run(input);
      },
    });
    try {
      const session = await manager.create({
        gameId: document.metadata.gameId,
        authority: "staging",
      });
      const event = document.events[0];
      if (event === undefined) throw new Error("missing fixture event");
      await expect(
        manager.command(
          session.sessionId,
          0,
          { kind: "delete_event", commandId: "anonymous", eventId: event.identity.eventId },
          true,
        ),
      ).rejects.toThrow("snapshot");
      expect(manager.get(session.sessionId)).toEqual(session);
    } finally {
      manager.close();
      await workspace.close();
    }
  });
  it("계산 실패는 undo 이력을 보존하고 동시 명령은 session version 순서로 검증한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-session-worker-failure-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    let failCompile = false;
    const computation: ComputationRunner = {
      async run(input) {
        if (input.kind === "compile" && failCompile) throw new Error("worker stopped");
        return inlineComputation.run(input);
      },
    };
    const manager = new CorrectionSessionManager(
      workspace,
      undefined,
      undefined,
      undefined,
      computation,
    );
    try {
      const session = await manager.create({
        authority: "staging",
        gameId: document.metadata.gameId,
      });
      const eventId = document.events[0]?.identity.eventId;
      if (eventId === undefined) throw new Error("missing fixture event");
      const command = { kind: "delete_event" as const, commandId: "anon-delete", eventId };
      const pair = await Promise.allSettled([
        manager.command(session.sessionId, 0, command, true),
        manager.command(session.sessionId, 0, command, true),
      ]);
      expect(pair[0]?.status).toBe("fulfilled");
      expect(pair[1]).toMatchObject({
        status: "rejected",
        reason: expect.any(StaleCorrectionSessionError),
      });
      const before = manager.get(session.sessionId);
      failCompile = true;
      await expect(manager.undo(session.sessionId, 1)).rejects.toThrow("worker stopped");
      expect(manager.get(session.sessionId)).toEqual(before);
      failCompile = false;
      expect((await manager.undo(session.sessionId, 1)).session.draftDocument).toEqual(document);
    } finally {
      manager.close();
      await workspace.close();
    }
  });
  it("비식별 작업 사본의 응답을 격리하고 오래된 clean session만 회수한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-session-lifetime-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction-record-mismatch.anonymized.json", "utf8"),
      ) as unknown,
    );
    await workspace.saveQuarantine(
      document,
      compilerFindings(compileStagingGameDocumentV2(document).findings),
    );
    let now = 0,
      id = 0;
    const manager = new CorrectionSessionManager(
      workspace,
      () => `session-${String(++id)}`,
      undefined,
      () => now,
    );
    try {
      const clean = await manager.create({
        authority: "quarantine",
        gameId: document.metadata.gameId,
      });
      const originalName = clean.draftDocument.teams.away.name;
      clean.draftDocument.teams.away.name = "caller changed";
      expect(manager.get(clean.sessionId).draftDocument.teams.away.name).toBe(originalName);
      const dirty = await manager.create({
        authority: "quarantine",
        gameId: document.metadata.gameId,
      });
      const event = dirty.draftDocument.events[0];
      if (event === undefined) throw new Error("missing anonymized event");
      const applied = await manager.command(
        dirty.sessionId,
        0,
        { commandId: "delete-anon-event", kind: "delete_event", eventId: event.identity.eventId },
        true,
      );
      expect(manager.get(dirty.sessionId)).toEqual(applied.session);
      expect(applied.session.sessionVersion).toBe(1);
      now = 31 * 60_000;
      const next = await manager.create({
        authority: "quarantine",
        gameId: document.metadata.gameId,
      });
      expect(() => manager.get(clean.sessionId)).toThrow(CorrectionSessionNotFoundError);
      expect(manager.get(dirty.sessionId).dirty).toBe(true);
      await expect(manager.delete(dirty.sessionId, 0)).rejects.toThrow(StaleCorrectionSessionError);
      await manager.delete(dirty.sessionId, 1);
      await manager.delete(next.sessionId, next.sessionVersion);
    } finally {
      manager.close();
      await workspace.close();
    }
  });

  it("미리보기 계산 중인 clean session은 유휴 시간이 지나도 회수하지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-active-session-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction-record-mismatch.anonymized.json", "utf8"),
      ) as unknown,
    );
    await workspace.saveQuarantine(
      document,
      compilerFindings(compileStagingGameDocumentV2(document).findings),
    );
    let now = 0;
    let release = (): void => undefined;
    let notifyStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new CorrectionSessionManager(workspace, undefined, undefined, () => now, {
      async run(input) {
        if (input.kind === "command") {
          notifyStarted();
          await released;
        }
        return inlineComputation.run(input);
      },
    });
    try {
      const session = await manager.create({
        authority: "quarantine",
        gameId: document.metadata.gameId,
      });
      const event = document.events[0];
      if (event === undefined) throw new Error("missing anonymized event");
      const preview = manager.command(
        session.sessionId,
        0,
        {
          kind: "delete_event",
          commandId: "active-preview",
          eventId: event.identity.eventId,
        },
        false,
      );
      await started;
      now = 31 * 60_000;
      await manager.create({ authority: "quarantine", gameId: document.metadata.gameId });
      expect(manager.get(session.sessionId)).toEqual(session);
      release();
      await expect(preview).resolves.toMatchObject({
        session: { sessionVersion: 0, dirty: false },
      });
      now += 31 * 60_000;
      await manager.create({ authority: "quarantine", gameId: document.metadata.gameId });
      expect(() => manager.get(session.sessionId)).toThrow(CorrectionSessionNotFoundError);
    } finally {
      release();
      manager.close();
      await workspace.close();
    }
  });

  it("작업 사본 상한을 넘겨도 기존 세션을 지우지 않는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-session-bound-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    let id = 0;
    const manager = new CorrectionSessionManager(workspace, () => `bounded-${String(++id)}`);
    try {
      for (let i = 0; i < 64; i++)
        await manager.create({ authority: "staging", gameId: document.metadata.gameId });
      await expect(
        manager.create({ authority: "staging", gameId: document.metadata.gameId }),
      ).rejects.toThrow(CorrectionSessionLimitError);
      expect(manager.get("bounded-1").sessionVersion).toBe(0);
      await manager.delete("bounded-1", 0);
      await expect(
        manager.create({ authority: "staging", gameId: document.metadata.gameId }),
      ).resolves.toMatchObject({ sessionId: "bounded-65" });
    } finally {
      manager.close();
      await workspace.close();
    }
  });
  it("단일 current 원장만 읽고 전체 catalog 스캔 없이 작업 사본을 연다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-current-snapshot-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction-record-mismatch.anonymized.json", "utf8"),
      ) as unknown,
    );
    const replay = compileStagingGameDocumentV2(document);
    await workspace.saveQuarantine(document, compilerFindings(replay.findings));
    const catalog = vi
      .spyOn(workspace, "catalog")
      .mockRejectedValue(new Error("전체 catalog 조회는 session 생성 경로가 아닙니다."));
    const manager = new CorrectionSessionManager(workspace, () => "session-current-snapshot");

    await expect(
      manager.create({ authority: "quarantine", gameId: document.metadata.gameId }),
    ).resolves.toMatchObject({
      sessionId: "session-current-snapshot",
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });
    expect(catalog).not.toHaveBeenCalled();
    await workspace.close();
  });

  it("격리 당시 finding과 reducer event 상태를 보정 session에 함께 제공한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-context-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveQuarantine(document, [
      {
        producer: "collection",
        lifecycle: "persistent",
        code: "source.pitch_unresolved",
        category: "source",
        severity: "blocking",
        message: "다음 타자의 투구를 연결할 수 없습니다.",
        eventSequence: 2,
        endpoint: "relay/1",
      },
    ]);
    const manager = new CorrectionSessionManager(workspace, () => "session-context");

    const created = await manager.create({
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });

    expect(created.authority).toBe("quarantine");
    expect(created.storedFindings).toEqual([
      expect.objectContaining({ code: "source.pitch_unresolved" }),
    ]);
    expect(created.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "source.pitch_unresolved" })]),
    );
    expect(created.eventContexts).toHaveLength(document.events.length);
    expect(created.eventContexts[2]).toMatchObject({
      eventId: "e2",
      before: { balls: 0, strikes: 0, outs: 0 },
      after: { balls: 1, strikes: 0, outs: 0 },
      pitch: {
        plateAppearanceEventId: "e1",
        pitchEventNumber: 1,
        actualPitchNumber: 1,
        sourcePitchId: "p-duplicate",
        actual: true,
      },
    });
    await workspace.close();
  });

  it("비식별 공식 기록 불일치의 선수별 compiler 기록을 session에 제공한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-records-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction-record-mismatch.anonymized.json", "utf8"),
      ) as unknown,
    );
    const replay = compileStagingGameDocumentV2(document);
    await workspace.saveQuarantine(document, compilerFindings(replay.findings));
    const manager = new CorrectionSessionManager(workspace, () => "session-records");

    const created = await manager.create({
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });

    expect(created.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "official_batter_record_mismatch",
          recordIdentity: "batter:anon-batter",
          details: [{ field: "runsBattedIn", expected: 1, actual: 0 }],
        }),
        expect.objectContaining({
          code: "official_pitcher_record_mismatch",
          recordIdentity: "pitcher:anon-pitcher",
          details: [{ field: "pitches", expected: 4, actual: 3 }],
        }),
      ]),
    );
    expect(created.calculatedRecords).toMatchObject({
      batters: [
        {
          playerId: "anon-batter",
          side: "away",
          plateAppearances: 1,
          runsBattedIn: 0,
          strikeouts: 1,
        },
      ],
      pitchers: [
        {
          playerId: "anon-pitcher",
          side: "home",
          battersFaced: 1,
          outsRecorded: 1,
          pitches: 3,
          strikes: 3,
        },
      ],
    });
    await workspace.close();
  });

  it("preview/apply와 command 단위 undo/redo 후 현재 상태만 commit한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    const manager = new CorrectionSessionManager(workspace, () => "session-1");
    const created = await manager.create({
      authority: "staging",
      gameId: document.metadata.gameId,
    });
    const command = {
      commandId: "move-command",
      kind: "move_event" as const,
      eventId: "e4",
      beforeEventId: "e2",
    };

    const preview = await manager.command(created.sessionId, 0, command, false);
    expect(preview.session).toMatchObject({ sessionVersion: 0, dirty: false });
    expect(preview.preview.beforeDocumentHash).not.toBe(preview.preview.afterDocumentHash);

    const applied = await manager.command(created.sessionId, 0, command, true);
    expect(applied.session).toMatchObject({
      sessionVersion: 1,
      canUndo: true,
      dirty: true,
    });
    await expect(manager.command(created.sessionId, 0, command, true)).rejects.toThrow(
      StaleCorrectionSessionError,
    );
    const undone = await manager.undo(created.sessionId, 1);
    expect(undone.session.draftDocumentHash).toBe(created.draftDocumentHash);
    const redone = await manager.redo(created.sessionId, 2);
    expect(redone.session.draftDocumentHash).toBe(applied.session.draftDocumentHash);

    const committed = await manager.commit(created.sessionId, {
      expectedSessionVersion: 3,
      allowBlockingStaging: false,
    });
    expect(committed).toMatchObject({
      committedAuthority: "staging",
      session: { sessionVersion: 4, dirty: false, canUndo: false },
    });
    await expect(readdir(path.join(temporary.path, "history"))).rejects.toThrow();
    expect(
      await workspace.readOriginal(document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    await workspace.close();
  });

  it("commit I/O 중 같은 version 명령을 거부해 최신 session 상태 유실을 막는다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-race-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    let releaseCommit: (() => void) | undefined;
    let notifyCommitStarted: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const delayedWorkspace = {
      readCurrentDocumentSnapshot: (
        ...args: Parameters<StagingWorkspace["readCurrentDocumentSnapshot"]>
      ) => workspace.readCurrentDocumentSnapshot(...args),
      readOriginal: (...args: Parameters<StagingWorkspace["readOriginal"]>) =>
        workspace.readOriginal(...args),
      readSourceBundle: (...args: Parameters<StagingWorkspace["readSourceBundle"]>) =>
        workspace.readSourceBundle(...args),
      commitCorrection: async (...args: Parameters<StagingWorkspace["commitCorrection"]>) => {
        notifyCommitStarted?.();
        await release;
        return workspace.commitCorrection(...args);
      },
    };
    const manager = new CorrectionSessionManager(delayedWorkspace, () => "session-race");
    const created = await manager.create({
      authority: "staging",
      gameId: document.metadata.gameId,
    });
    await manager.command(
      created.sessionId,
      0,
      { commandId: "race-move", kind: "move_event", eventId: "e4", beforeEventId: "e2" },
      true,
    );

    const committing = manager.commit(created.sessionId, {
      expectedSessionVersion: 1,
      allowBlockingStaging: false,
    });
    await commitStarted;
    const concurrent = manager.command(
      created.sessionId,
      1,
      { commandId: "concurrent-delete", kind: "delete_event", eventId: "e2" },
      true,
    );
    releaseCommit?.();
    await expect(committing).resolves.toMatchObject({
      session: { sessionVersion: 2, dirty: false },
    });
    await expect(concurrent).rejects.toThrow(StaleCorrectionSessionError);
    await workspace.close();
  });

  it("다중 행 추가 batch를 한 번의 version 증가와 undo 단위로 처리한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-batch-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    const manager = new CorrectionSessionManager(workspace, () => "session-batch");
    const created = await manager.create({
      authority: "staging",
      gameId: document.metadata.gameId,
    });
    const firstId = "019d0000-0000-7000-8000-000000000031";
    const secondId = "019d0000-0000-7000-8000-000000000032";
    const command = {
      commandId: "batch-add",
      kind: "correction_batch" as const,
      commands: [
        {
          commandId: "batch-add-first",
          kind: "add_event" as const,
          beforeEventId: "e2",
          event: manualAdministrative(firstId, "비식별 첫 행"),
        },
        {
          commandId: "batch-add-second",
          kind: "add_event" as const,
          beforeEventId: "e2",
          event: manualAdministrative(secondId, "비식별 둘째 행"),
        },
      ],
    };

    const applied = await manager.command(created.sessionId, 0, command, true);
    expect(applied.session.sessionVersion).toBe(1);
    expect(
      applied.session.draftDocument.events.slice(2, 4).map((event) => event.identity.eventId),
    ).toEqual([firstId, secondId]);
    await expect(manager.command(created.sessionId, 0, command, true)).rejects.toThrow(
      StaleCorrectionSessionError,
    );

    const undone = await manager.undo(created.sessionId, 1);
    expect(undone.session.sessionVersion).toBe(2);
    expect(undone.session.draftDocument.events).toHaveLength(document.events.length);
    expect(undone.session.draftDocumentHash).toBe(created.draftDocumentHash);
    await workspace.close();
  });

  it("최초 수집본을 작업 사본으로 불러오고 한 번의 undo로 현재 작업을 복원한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-original-load-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const original = await goldenDocument();
    await workspace.saveReady(original, []);
    const current = applyCorrectionCommand(original, {
      commandId: "prepare-current",
      kind: "move_event",
      eventId: "e4",
      beforeEventId: "e2",
    });
    await workspace.commitCorrection({
      baseAuthority: "staging",
      targetAuthority: "staging",
      baseDocumentHash: stagingDocumentHash(original),
      document: current.document,
      findingEnvelope: {
        schemaVersion: 2,
        findings: compilerFindings(current.replay.findings),
      },
    });
    const manager = new CorrectionSessionManager(workspace, () => "session-original");
    const created = await manager.create({
      authority: "staging",
      gameId: original.metadata.gameId,
    });

    expect(await manager.original(created.sessionId)).toEqual(original);
    const loaded = await manager.loadOriginal(created.sessionId, 0);
    expect(loaded.session.draftDocument).toEqual(original);
    expect(loaded.session).toMatchObject({
      sessionVersion: 1,
      canUndo: true,
      dirty: true,
    });
    const undone = await manager.undo(created.sessionId, 1);
    expect(undone.session.draftDocument).toEqual(current.document);
    await workspace.close();
  });

  it("sealed revision draft에서 original을 불러와도 revisionBase를 유지한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-original-load-revision-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const original = await goldenDocument();
    await workspace.saveReady(original, []);
    const sealed = parseStagingGameDocumentV2({
      ...original,
      revisionBase: {
        kind: "sealed_revision",
        revision: 1,
        documentHash: "a".repeat(64),
      },
    });
    await workspace.commitCorrection({
      baseAuthority: "staging",
      targetAuthority: "staging",
      baseDocumentHash: stagingDocumentHash(original),
      document: sealed,
      findingEnvelope: {
        schemaVersion: 2,
        findings: compilerFindings(compileStagingGameDocumentV2(sealed).findings),
      },
    });
    const manager = new CorrectionSessionManager(workspace, () => "session-original-revision");
    const created = await manager.create({
      authority: "staging",
      gameId: original.metadata.gameId,
    });

    const loaded = await manager.loadOriginal(created.sessionId, 0);
    expect(loaded.session.draftDocument.revisionBase).toEqual(sealed.revisionBase);
    await workspace.close();
  });

  it("tracking 연결을 해제한 즉시 삭제를 한 번의 undo/redo 단위로 처리한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-linked-delete-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    const manager = new CorrectionSessionManager(workspace, () => "session-linked-delete");
    const created = await manager.create({
      authority: "staging",
      gameId: document.metadata.gameId,
    });

    const deleted = await manager.command(
      created.sessionId,
      0,
      {
        commandId: "delete-linked-and-unlink",
        kind: "delete_event",
        eventId: "e2",
      },
      true,
    );
    expect(
      deleted.session.draftDocument.events.some((event) => event.identity.eventId === "e2"),
    ).toBe(false);
    expect(deleted.session.draftDocument.trackingCandidates[0]?.resolution).toEqual({
      kind: "excluded",
      reason: "manual_other",
      note: "연결된 원장 투구 행이 삭제되었습니다.",
    });
    expect(deleted.session).toMatchObject({
      canUndo: true,
      canRedo: false,
      sessionVersion: 1,
    });

    const undone = await manager.undo(created.sessionId, 1);
    expect(
      undone.session.draftDocument.events.some((event) => event.identity.eventId === "e2"),
    ).toBe(true);
    expect(undone.session.draftDocument.trackingCandidates[0]?.resolution).toEqual({
      kind: "linked",
      pitchEventId: "e2",
    });
    const redone = await manager.redo(created.sessionId, 2);
    expect(
      redone.session.draftDocument.events.some((event) => event.identity.eventId === "e2"),
    ).toBe(false);
    await workspace.close();
  });

  it("비식별 fixture의 저장 당시 tracking 차단은 교정 후 현재 finding으로 되살리지 않는다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-tracking-finding-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const fixture = await goldenDocument();
    const document = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((candidate) =>
        candidate.trackingId === "t1"
          ? { ...candidate, resolution: { kind: "pending" as const } }
          : candidate,
      ),
    });
    await workspace.saveQuarantine(document, [
      {
        producer: "collection",
        lifecycle: "recomputed",
        code: "source.tracking.unlinked",
        category: "source",
        severity: "blocking",
        message: "수집 당시 tracking 후보를 연결하지 못했습니다.",
        recordIdentity: "t1",
      },
      {
        producer: "collection",
        lifecycle: "recomputed",
        code: "source.tracking.pending",
        category: "source",
        severity: "blocking",
        message: "수집 당시 tracking 후보가 미해결 상태였습니다.",
        recordIdentity: "t1",
      },
    ]);
    const manager = new CorrectionSessionManager(workspace, () => "session-tracking-finding");
    const created = await manager.create({
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });

    expect(created.findings.map((finding) => finding.code)).toContain("source.tracking.pending");
    const corrected = await manager.command(
      created.sessionId,
      0,
      {
        commandId: "exclude-resolved-candidate",
        kind: "exclude_tracking_candidate",
        trackingId: "t1",
        reason: "provider_conflict",
      },
      true,
    );

    expect(corrected.session.blockingCount).toBe(0);
    expect(corrected.session.findings.map((finding) => finding.code)).not.toContain(
      "source.tracking.unlinked",
    );
    expect(corrected.session.findings.map((finding) => finding.code)).not.toContain(
      "source.tracking.pending",
    );
    expect(corrected.session.storedFindings.map((finding) => finding.code)).toEqual([
      "source.tracking.unlinked",
      "source.tracking.pending",
    ]);
    await workspace.close();
  });

  it("삭제하거나 typed 교체한 unresolved 행의 source finding은 저장 당시 기록으로만 남긴다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-source-finding-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const base = await goldenDocument();
    const eventId = "anon-source-unresolved";
    const document = parseStagingGameDocumentV2({
      ...base,
      events: [
        ...base.events,
        {
          identity: {
            kind: "source",
            eventId,
            endpoint: "anon-relay",
            blockIndex: 1,
            eventIndex: 0,
          },
          sequence: base.events.length,
          inning: 1,
          half: "top",
          kind: "unresolved",
          payload: { sourceType: "anon-type", suspectedKind: "administrative" },
          relayText: "비식별 반복 원천 행",
        },
      ],
    });
    await workspace.saveQuarantine(document, [
      {
        producer: "collection",
        lifecycle: "while_event_unresolved",
        code: "source.relay.entity.entity.wrong_team",
        category: "source",
        severity: "blocking",
        message: "비식별 원천 선수 문맥을 확인할 수 없습니다.",
        eventId,
        endpoint: "anon-relay",
      },
    ]);
    const manager = new CorrectionSessionManager(workspace, () => "session-source-finding");
    const created = await manager.create({
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });

    expect(created.findings.map((finding) => finding.code)).toContain(
      "source.relay.entity.entity.wrong_team",
    );
    const deleted = await manager.command(
      created.sessionId,
      0,
      { commandId: "delete-source-row", kind: "delete_event", eventId },
      true,
    );
    expect(deleted.session.findings.map((finding) => finding.code)).not.toContain(
      "source.relay.entity.entity.wrong_team",
    );
    expect(deleted.session.storedFindings.map((finding) => finding.code)).toContain(
      "source.relay.entity.entity.wrong_team",
    );

    const undone = await manager.undo(created.sessionId, 1);
    const replaced = await manager.command(
      created.sessionId,
      undone.session.sessionVersion,
      {
        commandId: "type-source-row",
        kind: "replace_event",
        eventId,
        event: manualAdministrative(
          "019d0000-0000-7000-8000-000000000099",
          "비식별 반복 원천 확인",
        ),
      },
      true,
    );
    expect(replaced.session.findings.map((finding) => finding.code)).not.toContain(
      "source.relay.entity.entity.wrong_team",
    );
    expect(replaced.session.findings.map((finding) => finding.code)).not.toContain(
      "source.unresolved_relay_row",
    );
    await workspace.close();
  });

  it("blocking draft는 명시적 허용 없이는 저장하지 않고 허용 시 quarantine으로 보낸다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-block-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    const manager = new CorrectionSessionManager(workspace, () => "session-2");
    const created = await manager.create({
      authority: "staging",
      gameId: document.metadata.gameId,
    });
    const applied = await manager.command(
      created.sessionId,
      0,
      { commandId: "delete-half-start", kind: "delete_event", eventId: "e0" },
      true,
    );
    expect(applied.session.blockingCount).toBeGreaterThan(0);
    await expect(
      manager.commit(created.sessionId, {
        expectedSessionVersion: 1,
        allowBlockingStaging: false,
      }),
    ).rejects.toBeInstanceOf(CorrectionCommitBlockedError);
    const committed = await manager.commit(created.sessionId, {
      expectedSessionVersion: 1,
      allowBlockingStaging: true,
    });
    expect(committed.committedAuthority).toBe("quarantine");
    expect((await workspace.catalog()).games[0]?.authority).toBe("quarantine");
    await workspace.close();
  });

  it("과거 compiler 오탐만 남은 clean quarantine을 변경 없이 명시적으로 staging 승격한다", async () => {
    await using temporary = await mkdtempDisposable(
      path.join(tmpdir(), "kbo-correction-clean-promotion-"),
    );
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveQuarantine(document, [
      {
        producer: "compiler",
        lifecycle: "recomputed",
        code: "source_observation_mismatch",
        category: "source",
        severity: "blocking",
        message: "과거 compiler 관측 비교에서 생성된 오탐입니다.",
        eventId: "e2",
        eventSequence: 2,
        details: [{ field: "homeScore", expected: 1, actual: 2 }],
      },
    ]);
    const manager = new CorrectionSessionManager(workspace, () => "session-clean-promotion");
    const created = await manager.create({
      authority: "quarantine",
      gameId: document.metadata.gameId,
    });

    expect(created).toMatchObject({ authority: "quarantine", dirty: false, blockingCount: 0 });
    expect(created.storedFindings).toEqual([
      expect.objectContaining({ code: "source_observation_mismatch", severity: "blocking" }),
    ]);
    expect(created.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(created.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(created.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "source.pitch_id.reused_within_game",
        "source.tracking.missing_for_pitch",
      ]),
    );

    const committed = await manager.commit(created.sessionId, {
      expectedSessionVersion: 0,
      allowBlockingStaging: false,
    });
    expect(committed).toMatchObject({
      committedAuthority: "staging",
      session: { authority: "staging", dirty: false, blockingCount: 0, sessionVersion: 1 },
    });
    expect(await workspace.readDocument("staging", 2026, document.metadata.gameId)).toEqual(
      document,
    );
    expect(
      (await workspace.readFindings("staging", 2026, document.metadata.gameId)).every(
        (finding) => finding.severity === "warning",
      ),
    ).toBe(true);
    await expect(
      workspace.readDocument("quarantine", 2026, document.metadata.gameId),
    ).rejects.toThrow();
    expect(
      (await readdir(path.join(temporary.path, "superseded", document.metadata.gameId))).filter(
        (file) => file.endsWith(".document.json"),
      ),
    ).toHaveLength(1);
    await expect(
      manager.commit(created.sessionId, {
        expectedSessionVersion: 1,
        allowBlockingStaging: false,
      }),
    ).rejects.toThrow("저장할 보정 작업이 없습니다.");
    await workspace.close();
  });

  it("superseded snapshot을 current 원장으로 원자 복구한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-superseded-session-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const document = await goldenDocument();
    await workspace.saveReady(document, []);
    await workspace.saveSourceFailure(
      document.metadata.gameId,
      [
        {
          producer: "collection",
          lifecycle: "persistent",
          code: "source.fetch_failed",
          category: "source",
          severity: "blocking",
          message: "비식별 재수집 실패",
        },
      ],
      document.metadata.season,
    );
    const snapshots = (
      await readdir(path.join(temporary.path, "superseded", document.metadata.gameId))
    ).filter((name) => name.endsWith(".document.json"));
    expect(snapshots).toHaveLength(1);
    const snapshotId = snapshots[0];
    if (snapshotId === undefined) throw new Error("superseded fixture snapshot이 없습니다.");

    const manager = new CorrectionSessionManager(workspace, () => "session-superseded");
    const created = await manager.create({
      authority: "superseded",
      gameId: document.metadata.gameId,
      snapshotId,
    });
    expect(created).toMatchObject({ authority: "superseded", snapshotId, dirty: false });

    const committed = await manager.commit(created.sessionId, {
      expectedSessionVersion: 0,
      allowBlockingStaging: false,
    });
    expect(committed).toMatchObject({
      committedAuthority: "staging",
      session: { authority: "staging", dirty: false },
    });
    expect(committed.session).not.toHaveProperty("snapshotId");
    expect(
      await workspace.readDocument("staging", document.metadata.season, document.metadata.gameId),
    ).toEqual(document);
    await workspace.close();
  });
});

function compilerFindings(findings: readonly Finding[]): StoredFinding[] {
  return findings.map((finding) => ({
    producer: "compiler",
    lifecycle: "recomputed",
    code: finding.code,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    ...(finding.eventId === undefined ? {} : { eventId: finding.eventId }),
    ...(finding.eventSequence === undefined ? {} : { eventSequence: finding.eventSequence }),
    ...(finding.recordIdentity === undefined ? {} : { recordIdentity: finding.recordIdentity }),
    ...(finding.details.length === 0
      ? {}
      : { details: finding.details.map((detail) => ({ ...detail })) }),
  }));
}

async function goldenDocument() {
  const document = parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
  expect(stagingDocumentHash(document)).toBeTruthy();
  expect(compileStagingGameDocumentV2(document)).toBeTruthy();
  return document;
}

function manualAdministrative(eventId: string, relayText: string) {
  return {
    identity: { kind: "manual" as const, eventId },
    sequence: 0,
    inning: 1,
    half: "top" as const,
    kind: "administrative" as const,
    payload: { code: "announcement" as const },
    relayText,
  };
}
