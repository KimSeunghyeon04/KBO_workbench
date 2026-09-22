import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type CorrectionSession, parseStagingGameDocumentV2 } from "@kbo/contracts";
import { extractNaverSourceEvidence, hashRawGameBundle, type RawGameBundle } from "@kbo/collection";
import { StagingWorkspace } from "@kbo/persistence";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../apps/server/src/app.js";
import type { AppConfig } from "../../apps/server/src/config.js";
import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";

describe("correction HTTP API", () => {
  it("관측·문구 교정의 검증·version·undo/redo·저장과 원본 보존을 함께 확인한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-observation-api-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const initialDocument = parseStagingGameDocumentV2(
      JSON.parse(
        await readFile("tests/fixtures/correction/in-play-observation.anonymized.json", "utf8"),
      ) as unknown,
    );
    const sourceBundle: RawGameBundle = {
      gameId: initialDocument.metadata.gameId,
      collectedAt: initialDocument.source.collectedAt,
      missingEndpoints: [],
      payloads: {
        "test-relay": {
          result: {
            textRelayData: {
              textRelays: [
                {
                  textOptions: initialDocument.events.map((event, seqno) => ({
                    seqno,
                    text: event.relayText,
                  })),
                },
              ],
            },
          },
        },
      },
    };
    const sourceBundleHash = hashRawGameBundle(sourceBundle);
    const document = parseStagingGameDocumentV2({
      ...initialDocument,
      source: { ...initialDocument.source, sourceBundleHash },
    });
    await workspace.saveSourceBundle({
      ...sourceBundle,
      sourceBundleHash,
      season: document.metadata.season,
    });
    await workspace.saveQuarantine(document, []);
    const sessions = new CorrectionSessionManager(workspace, undefined, extractNaverSourceEvidence);
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: emptyCollectionJobs(),
      revisionStore: emptyRevisionStore(),
      importJobs: emptyImportJobs(),
      correctionSessions: sessions,
      async close() {
        sessions.close();
        await workspace.close();
      },
    });
    try {
      const initial = await sessions.create({
        authority: "quarantine",
        gameId: document.metadata.gameId,
      });
      const url = `/api/v2/correction-sessions/${initial.sessionId}`;
      const pitch = document.events[3];
      if (pitch === undefined) throw new Error("missing anonymous pitch");
      const observationCommand = {
        commandId: "correct-count",
        kind: "update_observed_state",
        eventId: "e3",
        observedStateAfter: { ...pitch.observedStateAfter, balls: 0 },
      };
      const relayText = "2구 타격 · 수동 확인 문구";
      const command = {
        commandId: "correct-count-and-text",
        kind: "correction_batch",
        commands: [
          observationCommand,
          {
            commandId: "edit-text",
            kind: "replace_event",
            eventId: "e3",
            event: { ...pitch, relayText },
          },
        ],
      };
      const invalid = await app.inject({
        method: "POST",
        url: `${url}/commands`,
        payload: {
          expectedSessionVersion: 0,
          apply: true,
          command: { ...observationCommand, observedStateAfter: { balls: -1 } },
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(sessions.get(initial.sessionId)).toEqual(initial);
      const applied = await app.inject({
        method: "POST",
        url: `${url}/commands`,
        payload: { expectedSessionVersion: 0, apply: true, command },
      });
      expect(applied.statusCode, applied.body).toBe(200);
      const corrected = sessions.get(initial.sessionId);
      expect(corrected.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
      expect(corrected.calculatedRecords).toEqual(initial.calculatedRecords);
      expect(corrected.draftDocument.events[3]?.relayText).toBe(relayText);
      const stale = await app.inject({
        method: "POST",
        url: `${url}/commands`,
        payload: { expectedSessionVersion: 0, apply: true, command },
      });
      expect(stale.statusCode).toBe(409);
      const undo = await app.inject({
        method: "POST",
        url: `${url}/undo`,
        payload: { expectedSessionVersion: 1 },
      });
      expect(undo.statusCode).toBe(200);
      expect(sessions.get(initial.sessionId).draftDocument).toEqual(document);
      const redo = await app.inject({
        method: "POST",
        url: `${url}/redo`,
        payload: { expectedSessionVersion: 2 },
      });
      expect(redo.statusCode).toBe(200);
      expect(sessions.get(initial.sessionId).draftDocument).toEqual(corrected.draftDocument);
      const committed = await app.inject({
        method: "POST",
        url: `${url}/commit`,
        payload: { expectedSessionVersion: 3, allowBlockingStaging: false },
      });
      expect(committed.statusCode, committed.body).toBe(200);
      expect(
        await workspace.readOriginal(document.metadata.season, document.metadata.gameId),
      ).toEqual(document);
      const reopened = await sessions.create({
        authority: "staging",
        gameId: document.metadata.gameId,
      });
      expect(reopened.draftDocument).toEqual(corrected.draftDocument);
      expect(reopened.canUndo).toBe(false);
      const evidence = await app.inject({
        method: "GET",
        url: `/api/v2/correction-sessions/${reopened.sessionId}/source-evidence/e3`,
      });
      expect(evidence.statusCode, evidence.body).toBe(200);
      const sourceRows = evidence.json<{
        relayRows: Array<{ selected: boolean; canonicalJson: string }>;
      }>().relayRows;
      expect(sourceRows.find((row) => row.selected)?.canonicalJson).toContain('"text":"2구 타격"');
      expect(sourceRows.find((row) => row.selected)?.canonicalJson).not.toContain(relayText);
    } finally {
      await app.close();
    }
  });
  it("session preview/apply/undo/commit과 stale version을 strict API로 제공한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-correction-api-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    const rawDocument = JSON.parse(
      await readFile("tests/fixtures/game-document-v2.golden.json", "utf8"),
    ) as {
      events: Array<Record<string, unknown>>;
      metadata: { gameId: string };
      source: Record<string, unknown>;
    };
    const firstEvent = rawDocument.events[0];
    if (firstEvent === undefined) throw new Error("correction API fixture에 event가 없습니다.");
    firstEvent.observedStateAfter = {
      awayScore: 0,
      balls: 0,
      bases: [false, false, false],
      homeScore: 0,
      outs: 0,
      strikes: 0,
    };
    const sourceBundle: RawGameBundle = {
      gameId: rawDocument.metadata.gameId,
      collectedAt: "2026-08-20T03:00:00.000Z",
      missingEndpoints: [],
      payloads: {
        relay: {
          result: {
            textRelayData: {
              textRelays: [
                {
                  textOptions: [
                    { seqno: 0, text: "1회초 시작" },
                    { seqno: 1, text: "비식별 타자 타석" },
                    { seqno: 2, text: "1구 볼", ptsPitchId: "p-duplicate" },
                  ],
                  ptsOptions: [{ pitchId: "p-duplicate", ballcount: 1, crossPlateX: 0.12 }],
                },
              ],
            },
          },
        },
      },
    };
    const sourceBundleHash = hashRawGameBundle(sourceBundle);
    rawDocument.source = {
      ...rawDocument.source,
      sourceBundleHash,
    };
    const document = parseStagingGameDocumentV2(rawDocument);
    await workspace.saveSourceBundle({
      ...sourceBundle,
      season: document.metadata.season,
      sourceBundleHash,
    });
    await workspace.saveReady(document, []);
    const sessions = new CorrectionSessionManager(workspace, undefined, extractNaverSourceEvidence);
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const app = createApp(testConfig(temporary.path), pool, {
      workspace,
      collectionJobs: emptyCollectionJobs(),
      revisionStore: emptyRevisionStore(),
      importJobs: emptyImportJobs(),
      correctionSessions: sessions,
      async close() {
        sessions.close();
        await workspace.close();
      },
    });

    const candidates = await app.inject({ method: "GET", url: "/api/v2/correction-games" });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toEqual({
      games: [
        expect.objectContaining({
          gameId: document.metadata.gameId,
          authority: "staging",
        }),
      ],
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v2/correction-sessions",
      payload: { authority: "staging", gameId: document.metadata.gameId },
    });
    expect(created.statusCode).toBe(201);
    const createdSession = created.json<CorrectionSession>();
    expect(createdSession.draftDocument.events[0]?.observedStateAfter?.bases).toEqual([
      false,
      false,
      false,
    ]);
    expect(createdSession.calculatedRecords.batters.length).toBeGreaterThan(0);
    expect(createdSession.calculatedRecords.pitchers.length).toBeGreaterThan(0);
    const sessionId = createdSession.sessionId;
    const original = await app.inject({
      method: "GET",
      url: `/api/v2/correction-sessions/${sessionId}/original`,
    });
    expect(original.statusCode).toBe(200);
    expect(original.json()).toMatchObject({
      metadata: { gameId: document.metadata.gameId },
    });
    const readSource = vi.spyOn(workspace, "readSourceBundle");
    const evidence = await app.inject({
      method: "GET",
      url: `/api/v2/correction-sessions/${sessionId}/source-evidence/e2`,
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    await app.inject({
      method: "GET",
      url: `/api/v2/correction-sessions/${sessionId}/source-evidence/e1`,
    });
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(evidence.json()).toMatchObject({
      eventId: "e2",
      endpoint: "relay",
      blockIndex: 0,
      eventIndex: 2,
      relayRows: [
        { rowIndex: 0, selected: false },
        { rowIndex: 1, selected: false },
        { rowIndex: 2, sourceSequence: 2, selected: true },
      ],
      trackingRows: [{ rowIndex: 0, sourcePitchId: "p-duplicate" }],
    });
    expect(
      evidence.json<{ relayRows: Array<{ canonicalJson: string }> }>().relayRows[2]?.canonicalJson,
    ).toContain('"ptsPitchId":"p-duplicate"');
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/commands`,
      payload: {
        expectedSessionVersion: 0,
        command: {
          commandId: "invalid-extra-field",
          kind: "delete_event",
          eventId: "e2",
          extra: true,
        },
        apply: false,
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_command" });
    const linkedDelete = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/commands`,
      payload: {
        expectedSessionVersion: 0,
        command: {
          commandId: "delete-linked",
          kind: "delete_event",
          eventId: "e2",
        },
        apply: false,
      },
    });
    expect(linkedDelete.statusCode, linkedDelete.body).toBe(200);
    expect(linkedDelete.json()).toMatchObject({
      session: { sessionVersion: 0, dirty: false },
      preview: { eventCountDelta: -1 },
    });
    const command = {
      commandId: "api-move",
      kind: "move_event",
      eventId: "e4",
      beforeEventId: "e2",
    };
    const preview = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/commands`,
      payload: { expectedSessionVersion: 0, command, apply: false },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      session: { sessionVersion: 0, dirty: false },
    });
    const applied = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/commands`,
      payload: { expectedSessionVersion: 0, command, apply: true },
    });
    expect(applied.json()).toMatchObject({
      session: { sessionVersion: 1, dirty: true },
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/undo`,
      payload: { expectedSessionVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale_session" });
    const loadedOriginal = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/load-original`,
      payload: { expectedSessionVersion: 1 },
    });
    expect(loadedOriginal.statusCode).toBe(200);
    expect(loadedOriginal.json()).toMatchObject({
      session: { sessionVersion: 2, canUndo: true },
    });
    const undoneOriginal = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/undo`,
      payload: { expectedSessionVersion: 2 },
    });
    expect(undoneOriginal.statusCode).toBe(200);
    const committed = await app.inject({
      method: "POST",
      url: `/api/v2/correction-sessions/${sessionId}/commit`,
      payload: {
        expectedSessionVersion: 3,
        allowBlockingStaging: false,
      },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({
      committedAuthority: "staging",
      session: { sessionVersion: 4, dirty: false },
    });
    await app.close();
  }, 15_000);
});

function emptyRevisionStore() {
  return {
    catalog: async () => [],
    storedGameIds: async () => [],
    countStoredGames: async () => 0,
    hydrate: async () => {
      throw new Error("unexpected hydrate");
    },
    revisions: async () => {
      throw new Error("unexpected revisions");
    },
  } as never;
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
    create: () => {
      throw new Error("unexpected import create");
    },
    get: () => {
      throw new Error("unexpected import get");
    },
    list: () => [],
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
    database: {
      database: "test",
      host: "db",
      password: "test",
      port: 5432,
      user: "test",
    },
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
