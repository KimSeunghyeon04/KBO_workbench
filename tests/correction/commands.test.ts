import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseStagingGameDocumentV2, type StagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand, CorrectionCommandError } from "@kbo/correction";

describe("평면 원장 보정 명령", () => {
  const manualId = "0198f1e2-7d2a-7000-8000-000000000001";
  it("추가·교체·이동·삭제 뒤 sequence를 다시 매기고 전체 compiler 결과를 반환한다", async () => {
    const document = await golden();
    const added = applyCorrectionCommand(document, {
      commandId: "add-admin",
      kind: "add_event",
      beforeEventId: "e2",
      event: manualAdministrative(manualId, 999, "기록 정정 확인"),
    });
    expect(added.document.events[2]).toMatchObject({
      sequence: 2,
      kind: "administrative",
      relayText: "기록 정정 확인",
    });

    const replaced = applyCorrectionCommand(added.document, {
      commandId: "replace-admin",
      kind: "replace_event",
      eventId: manualId,
      event: manualAdministrative("0198f1e2-7d2a-7000-8000-000000000002", 0, "공식 기록 확인 완료"),
    });
    expect(
      replaced.document.events.find((event) => event.identity.eventId === manualId),
    ).toMatchObject({
      identity: { eventId: manualId },
      relayText: "공식 기록 확인 완료",
    });

    const moved = applyCorrectionCommand(replaced.document, {
      commandId: "move-admin",
      kind: "move_event",
      eventId: manualId,
      beforeEventId: null,
    });
    expect(moved.document.events.at(-1)?.identity.eventId).toBe(manualId);
    expect(moved.document.events.map((event) => event.sequence)).toEqual(
      moved.document.events.map((_event, index) => index),
    );

    const deleted = applyCorrectionCommand(moved.document, {
      commandId: "delete-admin",
      kind: "delete_event",
      eventId: manualId,
    });
    expect(deleted.document.events).toHaveLength(document.events.length);
    expect(deleted.preview.eventCountDelta).toBe(-1);
  });

  it("수동 추가 경로에서 source identity를 위조할 수 없다", async () => {
    const document = await golden();
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "forged-source-add",
        kind: "add_event",
        beforeEventId: null,
        event: { ...document.events[0], sequence: document.events.length },
      }),
    ).toThrow(CorrectionCommandError);
  });

  it("연결된 타석 결과를 삭제하면 주자 행은 남고 dangling finding이 즉시 생긴다", async () => {
    const document = await golden();
    const corrected = applyCorrectionCommand(document, {
      commandId: "delete-result",
      kind: "delete_event",
      eventId: "e10",
    });
    expect(corrected.document.events.some((event) => event.identity.eventId === "e11")).toBe(true);
    expect(corrected.replay.findings.map((finding) => finding.code)).toContain(
      "dangling_plate_result_link",
    );
  });

  it("unresolved 행을 typed 행으로 교체하면서 원천 identity와 위치를 보존한다", async () => {
    const document = await golden();
    const unresolved = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e7"
          ? {
              ...event,
              kind: "unresolved",
              payload: { sourceType: "mystery", suspectedKind: "administrative" },
            }
          : event,
      ),
    });
    const corrected = applyCorrectionCommand(unresolved, {
      commandId: "resolve-row",
      kind: "replace_event",
      eventId: "e7",
      event: manualAdministrative(
        "0198f1e2-7d2a-7000-8000-000000000003",
        0,
        "잠시 후 경기를 계속합니다",
      ),
    });
    expect(corrected.document.events[7]).toMatchObject({
      identity: { kind: "source", eventId: "e7", eventIndex: 7 },
      sequence: 7,
      kind: "administrative",
      relayText: unresolved.events[7]?.relayText,
    });
    expect(corrected.replay.findings.map((finding) => finding.code)).not.toContain(
      "unresolved_relay_row",
    );
  });

  it("source 행 교체가 원문과 observedStateAfter를 보존한다", async () => {
    const base = await golden();
    const document = parseStagingGameDocumentV2({
      ...base,
      events: base.events.map((event) =>
        event.identity.eventId === "e7"
          ? {
              ...event,
              observedStateAfter: { balls: 1, strikes: 2, outs: 0 },
            }
          : event,
      ),
    });
    const corrected = applyCorrectionCommand(document, {
      commandId: "preserve-source-evidence",
      kind: "replace_event",
      eventId: "e7",
      event: manualAdministrative("0198f1e2-7d2a-7000-8000-000000000099", 0, "바꾸려 한 원문"),
    });

    expect(corrected.document.events[7]).toMatchObject({
      identity: document.events[7]?.identity,
      relayText: document.events[7]?.relayText,
      observedStateAfter: { balls: 1, strikes: 2, outs: 0 },
    });
  });

  it("roster와 공식 기록 update가 선수 ID를 암묵적으로 바꾸지 못하게 한다", async () => {
    const document = await golden();
    const player = document.rosters.away.players[0];
    if (player === undefined) throw new Error("away roster fixture가 없습니다.");
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "rename-roster-player",
        kind: "update_roster_player",
        side: "away",
        playerId: player.playerId,
        player: { ...player, playerId: "different-player" },
      }),
    ).toThrow(/선수 ID/);
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "rename-official-player",
        kind: "update_official_record",
        recordType: "batter",
        playerId: "a1",
        record: {
          playerId: "a2",
          side: "away",
          atBats: 0,
          runs: 0,
          hits: 0,
          homeRuns: 0,
          runsBattedIn: 0,
          walks: 0,
          strikeouts: 0,
        },
      }),
    ).toThrow(/선수 ID/);
  });

  it("tracking이 연결된 투구를 삭제하면 관측값은 남고 수동 제외로 전환한다", async () => {
    const document = await golden();
    const corrected = applyCorrectionCommand(document, {
      commandId: "delete-pitch",
      kind: "delete_event",
      eventId: "e2",
    });
    expect(corrected.document.trackingCandidates).toHaveLength(document.trackingCandidates.length);
    expect(corrected.document.trackingCandidates[0]?.resolution).toEqual({
      kind: "excluded",
      reason: "manual_other",
      note: "연결된 원장 투구 행이 삭제되었습니다.",
    });
  });

  it("투구 삭제·비투구 교체 시 직접 tracking과 종속 중복을 함께 제외한다", async () => {
    const base = await golden();
    const canonical = base.trackingCandidates[0];
    if (canonical === undefined) throw new Error("tracking fixture가 없습니다.");
    const document = parseStagingGameDocumentV2({
      ...base,
      trackingCandidates: [
        canonical,
        {
          ...canonical,
          trackingId: "dependent-duplicate",
          sequence: 1,
          source: { ...canonical.source, rowIndex: canonical.source.rowIndex + 1 },
          resolution: { kind: "duplicate", canonicalTrackingId: canonical.trackingId },
        },
      ],
    });
    const deleted = applyCorrectionCommand(document, {
      commandId: "delete-pitch-with-duplicate",
      kind: "delete_event",
      eventId: "e2",
    });
    expect(
      deleted.document.trackingCandidates.map((candidate) => candidate.resolution.kind),
    ).toEqual(["excluded", "excluded"]);

    const replaced = applyCorrectionCommand(document, {
      commandId: "replace-pitch-with-administrative",
      kind: "replace_event",
      eventId: "e2",
      event: manualAdministrative("0198f1e2-7d2a-7000-8000-000000000031", 0, "원천 중복 제외"),
    });
    expect(replaced.document.trackingCandidates.map((candidate) => candidate.resolution)).toEqual([
      {
        kind: "excluded",
        reason: "manual_other",
        note: "연결된 원장 투구 행이 비투구 행으로 교체되었습니다.",
      },
      {
        kind: "excluded",
        reason: "manual_other",
        note: "연결된 원장 투구 행이 비투구 행으로 교체되었습니다.",
      },
    ]);
  });

  it("비식별 회귀 fixture의 PA 경계를 삭제하면 동일 투구 tracking 문맥을 새 PA로 옮긴다", async () => {
    const document = await paRebaseFixture();
    const corrected = applyCorrectionCommand(document, {
      commandId: "remove-repeated-prefix",
      kind: "correction_batch",
      commands: [
        {
          commandId: "delete-old-pitch",
          kind: "delete_event",
          eventId: "anon-pitch-old",
        },
        {
          commandId: "delete-old-pa",
          kind: "delete_event",
          eventId: "anon-pa-old",
        },
      ],
    });

    expect(
      corrected.document.trackingCandidates.map((candidate) => candidate.plateAppearanceEventId),
    ).toEqual(["anon-pa-current", "anon-pa-current"]);
    expect(
      corrected.replay.findings.filter(
        (finding) =>
          finding.code === "domain.tracking.plate_appearance_mismatch" ||
          finding.code === "source.tracking.invalid_duplicate_resolution",
      ),
    ).toEqual([]);
  });

  it("PA 경계 교체·이동으로 동일 투구의 계산 PA가 바뀌어도 tracking이 따라간다", async () => {
    const document = await paRebaseFixture();
    const replaced = applyCorrectionCommand(document, {
      commandId: "replace-old-pa",
      kind: "replace_event",
      eventId: "anon-pa-old",
      event: manualAdministrative(
        "0198f1e2-7d2a-7000-8000-000000000041",
        0,
        "비식별 반복 머리글 제외",
      ),
    });
    expect(
      replaced.document.trackingCandidates.map((candidate) => candidate.plateAppearanceEventId),
    ).toEqual(["anon-pa-current", "anon-pa-current"]);

    const moved = applyCorrectionCommand(document, {
      commandId: "move-old-pa",
      kind: "move_event",
      eventId: "anon-pa-old",
      beforeEventId: "anon-result",
    });
    expect(
      moved.document.trackingCandidates.map((candidate) => candidate.plateAppearanceEventId),
    ).toEqual(["anon-pa-current", "anon-pa-current"]);
  });

  it("삭제된 PA를 가리키는 저장 문맥만 명시적으로 복구하고 실제 불일치는 유지한다", async () => {
    const original = await paRebaseFixture();
    const stale = parseStagingGameDocumentV2({
      ...original,
      events: original.events
        .filter(
          (event) =>
            event.identity.eventId !== "anon-pa-old" && event.identity.eventId !== "anon-pitch-old",
        )
        .map((event, sequence) => ({ ...event, sequence })),
    });
    const repaired = applyCorrectionCommand(stale, {
      commandId: "repair-stale-pa",
      kind: "reconcile_tracking_plate_appearance_contexts",
    });

    expect(
      repaired.document.trackingCandidates.map((candidate) => candidate.plateAppearanceEventId),
    ).toEqual(["anon-pa-current", "anon-pa-current"]);
    expect(
      repaired.replay.findings.filter(
        (finding) => finding.code === "domain.tracking.plate_appearance_mismatch",
      ),
    ).toEqual([]);

    const genuineMismatch = parseStagingGameDocumentV2({
      ...original,
      trackingCandidates: original.trackingCandidates.map((candidate) => ({
        ...candidate,
        plateAppearanceEventId: "anon-pa-current",
      })),
    });
    expect(() =>
      applyCorrectionCommand(genuineMismatch, {
        commandId: "do-not-hide-real-mismatch",
        kind: "reconcile_tracking_plate_appearance_contexts",
      }),
    ).toThrow(CorrectionCommandError);
  });

  it("다른 PA 투구로 수동 재연결하면 tracking 문맥을 덮어쓰지 않고 차단한다", async () => {
    const document = await golden();
    const corrected = applyCorrectionCommand(document, {
      commandId: "cross-pa-link",
      kind: "link_tracking_candidate",
      trackingId: "t1",
      pitchEventId: "e9",
    });

    expect(corrected.document.trackingCandidates[0]?.plateAppearanceEventId).toBe("e1");
    expect(corrected.replay.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "domain.tracking.plate_appearance_mismatch",
          recordIdentity: "t1",
        }),
      ]),
    );
  });

  it("unknown command field와 중계 문구 없는 수동 행을 strict하게 거부한다", async () => {
    const document = await golden();
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "unknown-field",
        kind: "delete_event",
        eventId: "e2",
        extra: true,
      } as never),
    ).toThrow(CorrectionCommandError);
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "missing-relay",
        kind: "add_event",
        beforeEventId: null,
        event: {
          ...manualAdministrative("0198f1e2-7d2a-7000-8000-000000000004", 0, "임시"),
          relayText: undefined,
        } as never,
      }),
    ).toThrow(CorrectionCommandError);
  });

  it("batch 중 하나가 실패하면 입력 문서를 변경하지 않는다", async () => {
    const document = await golden();
    const before = JSON.stringify(document);
    expect(() =>
      applyCorrectionCommand(document, {
        commandId: "atomic-batch",
        kind: "correction_batch",
        commands: [
          { commandId: "move", kind: "move_event", eventId: "e7", beforeEventId: "e2" },
          { commandId: "missing", kind: "delete_event", eventId: "does-not-exist" },
        ],
      }),
    ).toThrow(CorrectionCommandError);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("같은 anchor의 다중 추가를 child 명령 순서대로 연속 배치한다", async () => {
    const document = await golden();
    const firstId = "0198f1e2-7d2a-7000-8000-000000000021";
    const secondId = "0198f1e2-7d2a-7000-8000-000000000022";
    const corrected = applyCorrectionCommand(document, {
      commandId: "multi-add",
      kind: "correction_batch",
      commands: [
        {
          commandId: "multi-add-first",
          kind: "add_event",
          beforeEventId: "e2",
          event: manualAdministrative(firstId, 0, "비식별 첫 행"),
        },
        {
          commandId: "multi-add-second",
          kind: "add_event",
          beforeEventId: "e2",
          event: manualAdministrative(secondId, 0, "비식별 둘째 행"),
        },
      ],
    });

    expect(corrected.document.events.slice(2, 4).map((event) => event.identity.eventId)).toEqual([
      firstId,
      secondId,
    ]);
    expect(corrected.preview.eventCountDelta).toBe(2);
    expect(corrected.document.events.map((event) => event.sequence)).toEqual(
      corrected.document.events.map((_event, index) => index),
    );
  });
});

function manualAdministrative(eventId: string, sequence: number, relayText: string) {
  return {
    identity: { kind: "manual" as const, eventId },
    sequence,
    inning: 1,
    half: "top" as const,
    kind: "administrative" as const,
    payload: { code: "announcement" as const },
    relayText,
  };
}

async function golden(): Promise<StagingGameDocumentV2> {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}

async function paRebaseFixture(): Promise<StagingGameDocumentV2> {
  return parseStagingGameDocumentV2(
    JSON.parse(
      await readFile("tests/fixtures/correction-tracking-pa-rebase.anonymized.json", "utf8"),
    ) as unknown,
  );
}
