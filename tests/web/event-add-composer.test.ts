import {
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  addEventComposerReducer,
  buildAddEventCommand,
  createAddEventComposerState,
  createAddEventDraft,
  MAX_EVENT_DRAFTS,
  transientEventsAtAnchor,
  validateAddEventDrafts,
} from "../../apps/web/src/correction/event-add-composer.js";
import { emptyForm } from "../../apps/web/src/correction/event-editor-registry.js";
import type { EditorFormModel } from "../../apps/web/src/correction/event-editor-autofill.js";
import { pitchOrdinalAt } from "../../apps/web/src/events/relay-text.js";

describe("Correction 다중 이벤트 composer", () => {
  it("stable event ID를 유지하며 단일 add와 복수 atomic batch를 만든다", () => {
    const document = fixture();
    const first = draft("draft-1", "019d0000-0000-7000-8000-000000000001", "첫 행");
    const second = draft("draft-2", "019d0000-0000-7000-8000-000000000002", "둘째 행");
    let commandSequence = 0;
    const commandId = (): string => `command-${String(++commandSequence)}`;

    const single = buildAddEventCommand([first], document, "anchor", commandId);
    expect(single).toMatchObject({
      kind: "add_event",
      beforeEventId: "anchor",
      event: { identity: { eventId: first.eventId }, relayText: "첫 행" },
    });

    const batch = buildAddEventCommand([first, second], document, "anchor", commandId);
    expect(batch?.kind).toBe("correction_batch");
    if (batch?.kind !== "correction_batch") return;
    expect(batch.commands).toHaveLength(2);
    expect(batch.commands.map((item) => item.commandId)).toEqual(["command-2", "command-3"]);
    expect(
      batch.commands.map((item) => (item.kind === "add_event" ? item.beforeEventId : undefined)),
    ).toEqual(["anchor", "anchor"]);
    expect(
      batch.commands.map((item) =>
        item.kind === "add_event" ? item.event.identity.eventId : undefined,
      ),
    ).toEqual([first.eventId, second.eventId]);
  });

  it("queued 타석 결과와 판독 대상은 앞선 draft만 참조할 수 있다", () => {
    const document = fixture();
    const result = createAddEventDraft(
      model({
        ...emptyForm(1, "top"),
        kind: "plate_result",
        result: "single",
        batterId: "away-batter",
        pitcherId: "home-pitcher",
        relayText: "비식별 타자 : 안타",
      }),
      "019d0000-0000-7000-8000-000000000010",
      "result",
    );
    const runner = createAddEventDraft(
      model({
        ...emptyForm(1, "top"),
        kind: "runner_advance",
        runnerId: "away-runner",
        contextKind: "plate_result",
        plateResultEventId: result.eventId,
        relayText: "1루주자 비식별 주자 : 2루까지 진루",
      }),
      "019d0000-0000-7000-8000-000000000011",
      "runner",
    );
    const review = createAddEventDraft(
      model({
        ...emptyForm(1, "top"),
        kind: "review",
        reviewedEventId: runner.eventId,
        relayText: "비디오 판독 요청",
      }),
      "019d0000-0000-7000-8000-000000000012",
      "review",
    );

    expect(
      validateAddEventDrafts([result, runner, review], document).map((item) => item.error),
    ).toEqual([null, null, null]);
    expect(validateAddEventDrafts([runner, result, review], document)[0]?.error).toContain(
      "타석 결과",
    );
    expect(validateAddEventDrafts([review, result, runner], document)[0]?.error).toContain(
      "앞선 원장 행",
    );
  });

  it("불변 reducer로 선택·이동·삭제하고 100개 상한을 지킨다", () => {
    const first = draft("draft-1", "event-1", "첫 행");
    const second = draft("draft-2", "event-2", "둘째 행");
    let state = createAddEventComposerState(first);
    state = addEventComposerReducer(state, { type: "append", draft: second });
    const beforeMove = state.drafts;
    state = addEventComposerReducer(state, {
      type: "move",
      draftId: second.draftId,
      direction: -1,
    });
    expect(state.drafts).not.toBe(beforeMove);
    expect(state.drafts.map((item) => item.draftId)).toEqual(["draft-2", "draft-1"]);
    state = addEventComposerReducer(state, { type: "remove", draftId: second.draftId });
    expect(state.drafts.map((item) => item.draftId)).toEqual(["draft-1"]);

    for (let index = 2; index <= MAX_EVENT_DRAFTS + 1; index += 1) {
      state = addEventComposerReducer(state, {
        type: "append",
        draft: draft(`draft-${String(index)}`, `event-${String(index)}`, `${String(index)}번 행`),
      });
    }
    expect(state.drafts).toHaveLength(MAX_EVENT_DRAFTS);
    expect(state.announcement).toContain("최대 100개");
  });

  it("canonical 위치와 앞선 queued 행을 합쳐 투구 순번과 타석 경계를 계산한다", () => {
    const document = fixture();
    const queuedPitch = manualPitch("queued-pitch", "ball");
    const beforeSecond = transientEventsAtAnchor(document, "anchor", [queuedPitch]);
    expect(pitchOrdinalAt(beforeSecond, 2, queuedPitch)).toBe(2);

    const nextBatter: StagingRelayEvent = {
      identity: { kind: "manual", eventId: "queued-batter" },
      sequence: 0,
      inning: 1,
      half: "top",
      kind: "batter_start",
      payload: { batterId: "away-runner", pitcherId: "home-pitcher" },
      relayText: "비식별 주자 타석",
    };
    const afterBoundary = transientEventsAtAnchor(document, "anchor", [queuedPitch, nextBatter]);
    expect(pitchOrdinalAt(afterBoundary, 3, queuedPitch)).toBe(1);
  });
});

function draft(draftId: string, eventId: string, relayText: string) {
  return createAddEventDraft(
    model({
      ...emptyForm(1, "top"),
      kind: "administrative",
      adminCode: "announcement",
      relayText,
    }),
    eventId,
    draftId,
  );
}

function model(form: ReturnType<typeof emptyForm>): EditorFormModel {
  return { form, assignments: {}, notice: "" };
}

function manualPitch(eventId: string, call: "ball"): StagingRelayEvent {
  return {
    identity: { kind: "manual", eventId },
    sequence: 0,
    inning: 1,
    half: "top",
    kind: "pitch",
    payload: { call },
    relayText: "볼",
  };
}

function fixture(): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "multi-add-fixture",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "multi-add-fixture",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정팀" },
      home: { teamId: "HOME", name: "홈팀" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: [
          {
            playerId: "away-batter",
            name: "비식별 타자",
            starter: true,
            positions: ["타자"],
          },
          {
            playerId: "away-runner",
            name: "비식별 주자",
            starter: true,
            positions: ["주자"],
          },
        ],
      },
      home: {
        teamId: "HOME",
        players: [
          {
            playerId: "home-pitcher",
            name: "비식별 투수",
            starter: true,
            positions: ["투수"],
          },
        ],
      },
    },
    events: [
      {
        identity: {
          kind: "source",
          eventId: "batter-start",
          endpoint: "test-relay",
          blockIndex: 0,
          eventIndex: 0,
        },
        sequence: 0,
        inning: 1,
        half: "top",
        kind: "batter_start",
        payload: { batterId: "away-batter", pitcherId: "home-pitcher" },
        relayText: "비식별 타자 타석",
      },
      {
        identity: {
          kind: "source",
          eventId: "anchor",
          endpoint: "test-relay",
          blockIndex: 0,
          eventIndex: 1,
        },
        sequence: 1,
        inning: 1,
        half: "top",
        kind: "administrative",
        payload: { code: "announcement" },
        relayText: "원장 기준 행",
      },
    ],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}
