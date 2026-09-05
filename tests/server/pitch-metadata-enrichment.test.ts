import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mapNaverGame } from "@kbo/collection";
import { applyCorrectionCommand } from "@kbo/correction";
import { StagingWorkspace } from "@kbo/persistence";

import {
  enrichPitchMetadataGame,
  preparePitchMetadataEnrichment,
} from "../../apps/server/src/maintenance/pitch-metadata-enrichment.js";
import { CorrectionSessionManager } from "../../apps/server/src/correction-session-manager.js";
import { metadataBundle, stripMetadata } from "../helpers/pitch-metadata.js";
import { eventFromForm, formFrom } from "../../apps/web/src/correction/event-editor-registry.js";

describe("일회 구속·구종 보완", () => {
  it("100개 교체 배치는 입력을 바꾸지 않고 마지막 구속과 전체 검증 결과를 보존한다", async () => {
    const original = mapNaverGame(await metadataBundle()).document;
    const pitch = original.events.find((event) => event.kind === "pitch");
    if (pitch === undefined) throw new Error("투구 fixture 필요");
    const result = applyCorrectionCommand(original, {
      kind: "correction_batch",
      commandId: "hundred-pitch-edits",
      commands: Array.from({ length: 100 }, (_, index) => ({
        kind: "replace_event",
        commandId: `pitch-edit-${String(index)}`,
        eventId: pitch.identity.eventId,
        event: { ...pitch, payload: { ...pitch.payload, speedKph: 100 + index } },
      })),
    });
    expect(pitch.payload.speedKph).toBe(133);
    expect(result.document.events.find((event) => event.kind === "pitch")?.payload).toMatchObject({
      speedKph: 199,
      pitchType: "포크",
    });
    expect(result.replay.pitchFacts[0]?.speedKph).toBe(199);
    expect(result.replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(result.document.events.map((event) => event.sequence)).toEqual(
      original.events.map((_, index) => index),
    );
  });
  it("dry-run은 현재 파일을 유지하고 apply는 journal correction만 저장하며 재실행은 no-op이다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-enrich-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    try {
      const bundle = await metadataBundle();
      const document = stripMetadata(mapNaverGame(bundle).document);
      await workspace.saveSourceBundle({
        ...bundle,
        season: document.metadata.season,
        sourceBundleHash: document.source.sourceBundleHash,
      });
      await workspace.saveReady(document, []);
      const store = {
        loadCorrectionDraft: vi.fn(),
        importRevision: vi.fn(),
        currentRevisionBase: vi.fn(),
      };
      const preview = await enrichPitchMetadataGame(workspace, store, bundle.gameId, false);
      expect(preview).toMatchObject({
        status: "proposed",
        changedPitches: 1,
        before: { speed: 0, type: 0 },
        after: { speed: 1, type: 1 },
      });
      expect((await workspace.readCurrentDocumentSnapshot(bundle.gameId))?.document).toEqual(
        document,
      );
      const applied = await enrichPitchMetadataGame(workspace, store, bundle.gameId, true);
      expect(applied.status).toBe("applied");
      const current = await workspace.readCurrentDocumentSnapshot(bundle.gameId);
      expect(current?.document.revisionBase).toEqual(document.revisionBase);
      expect(await workspace.readOriginal(document.metadata.season, bundle.gameId)).toEqual(
        document,
      );
      expect(await enrichPitchMetadataGame(workspace, store, bundle.gameId, true)).toMatchObject({
        status: "unchanged",
        changedPitches: 0,
      });
      expect(store.importRevision).not.toHaveBeenCalled();
      expect(store.loadCorrectionDraft).not.toHaveBeenCalled();
    } finally {
      await workspace.close();
    }
  });
  it("DB-only 보완은 current base만 사용하며 stale import 실패를 전파한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-enrich-db-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    try {
      const bundle = await metadataBundle();
      const original = stripMetadata(mapNaverGame(bundle).document);
      const document = {
        ...original,
        revisionBase: {
          kind: "sealed_revision" as const,
          revision: 3,
          documentHash: "a".repeat(64),
        },
      };
      await workspace.saveSourceBundle({
        ...bundle,
        season: document.metadata.season,
        sourceBundleHash: document.source.sourceBundleHash,
      });
      const store = {
        currentRevisionBase: vi.fn().mockResolvedValue({ revision: 3 }),
        loadCorrectionDraft: vi.fn().mockResolvedValue(document),
        importRevision: vi.fn().mockRejectedValue(new Error("stale base")),
      };
      await expect(enrichPitchMetadataGame(workspace, store, bundle.gameId, true)).rejects.toThrow(
        "stale base",
      );
      expect(store.loadCorrectionDraft).toHaveBeenCalledWith(bundle.gameId, 3);
      expect(store.importRevision.mock.calls[0]?.[0].revisionBase).toEqual(document.revisionBase);
      expect(await workspace.readCurrentDocumentSnapshot(bundle.gameId)).toBeNull();
    } finally {
      await workspace.close();
    }
  });
  it("편집기 왕복·수동 삭제·undo/redo가 구속과 구종을 보존한다", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-pitch-editor-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    try {
      const document = mapNaverGame(await metadataBundle()).document;
      const pitch = document.events.find((event) => event.kind === "pitch");
      if (pitch === undefined) throw new Error("pitch fixture 필요");
      const form = formFrom({ mode: "replace_event", eventId: pitch.identity.eventId }, pitch);
      expect(eventFromForm({ ...form, call: "called_strike" }, document, pitch)).toMatchObject({
        payload: { speedKph: 133, pitchType: "포크" },
      });
      const removed = eventFromForm({ ...form, speedKph: "", pitchType: "" }, document, pitch);
      if (removed === null) throw new Error("수동 삭제 event 필요");
      expect(removed.payload).not.toHaveProperty("speedKph");
      expect(removed.payload).not.toHaveProperty("pitchType");
      await workspace.saveReady(document, []);
      const manager = new CorrectionSessionManager(workspace, () => "pitch-session");
      const session = await manager.create({
        authority: "staging",
        gameId: document.metadata.gameId,
      });
      const changed = await manager.command(
        session.sessionId,
        session.sessionVersion,
        {
          kind: "replace_event",
          commandId: "remove-pitch-metadata",
          eventId: pitch.identity.eventId,
          event: removed,
        },
        true,
      );
      const undone = await manager.undo(session.sessionId, changed.session.sessionVersion);
      expect(
        undone.session.draftDocument.events.find((event) => event.kind === "pitch")?.payload,
      ).toMatchObject({ speedKph: 133, pitchType: "포크" });
      const redone = await manager.redo(session.sessionId, undone.session.sessionVersion);
      expect(
        redone.session.draftDocument.events.find((event) => event.kind === "pitch")?.payload,
      ).not.toHaveProperty("speedKph");
    } finally {
      await workspace.close();
    }
  });
  it("metadata만 추가한 뒤 원장의 다른 내용과 계산 결과가 그대로다", async () => {
    const bundle = await metadataBundle();
    const document = stripMetadata(mapNaverGame(bundle).document);
    const result = preparePitchMetadataEnrichment(document, bundle);
    expect(stripMetadata(result.document)).toEqual(document);
    expect(result.replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(await readFile("tests/fixtures/naver/pitch-metadata.anonymized.json", "utf8")).toContain(
      "직구",
    );
  });
});
