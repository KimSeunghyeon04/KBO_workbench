import {
  parseStagingGameDocumentV2,
  type CorrectionEventContext,
  type CorrectionSession,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  buildEditorAutofillContext,
  initialEditorModel,
  invalidateContextAssignments,
  modelForKind,
  runnerBaseModel,
  runnerDestinationModel,
  runnerOutcomeModel,
  runnerPlayerModel,
  substitutionOutgoingModel,
  substitutionRoleModel,
} from "../../apps/web/src/correction/event-editor-autofill.js";
import {
  eventFromForm,
  formFrom,
  resultDefaults,
} from "../../apps/web/src/correction/event-editor-registry.js";

describe("Correction 편집기 자동 지정", () => {
  it("타석 결과 바로 뒤에 추가할 때만 결과와 1루 우선 주자를 자동 지정한다", () => {
    const document = fixture();
    const result = eventOfKind(document, "plate_result");
    const next = eventOfKind(document, "unresolved");
    const resultBefore = state({
      batterId: "batter-current",
      pitcherId: "pitcher-current",
      bases: ["runner-first", "runner-second", null],
    });
    const currentSession = session(document, [context(result, resultBefore)]);
    const afterRequest = {
      mode: "add_event" as const,
      beforeEventId: next.identity.eventId,
      seedEvent: result,
    };
    const afterContext = buildEditorAutofillContext(currentSession, afterRequest);
    const after = initialEditorModel(afterRequest, undefined, afterContext);

    expect(after.form).toMatchObject({
      kind: "runner_advance",
      runnerId: "runner-first",
      fromBase: "1",
      contextKind: "plate_result",
      plateResultEventId: result.identity.eventId,
      relayText: "",
    });
    expect(after.notice).toContain("주자(현재 1루)");
    expect(after.notice).toContain("연결 결과(직전 타석 결과)");

    const beforeRequest = {
      mode: "add_event" as const,
      beforeEventId: result.identity.eventId,
      seedEvent: result,
    };
    const beforeContext = buildEditorAutofillContext(currentSession, beforeRequest);
    const before = initialEditorModel(beforeRequest, undefined, beforeContext);
    expect(before.form.kind).toBe("pitch");
    expect(before.form.plateResultEventId).toBe("");
  });

  it("종류 변환 시 현재 타석 선수와 직전 판독 대상을 채우고 기존 행 열기는 보존한다", () => {
    const document = fixture();
    const unresolved = eventOfKind(document, "unresolved");
    const currentSession = session(document, [
      context(unresolved, state({ batterId: "batter-current", pitcherId: "pitcher-current" })),
    ]);
    const request = { mode: "replace_event" as const, eventId: unresolved.identity.eventId };
    const autofillContext = buildEditorAutofillContext(currentSession, request);
    const original = initialEditorModel(request, unresolved, autofillContext);
    expect(original.form.kind).toBe("unresolved");
    expect(original.assignments).toEqual({});

    const result = modelForKind(original.form, "plate_result", autofillContext);
    expect(result.form).toMatchObject({
      batterId: "batter-current",
      pitcherId: "pitcher-current",
    });
    expect(result.notice).toContain("타자(현재 타석)");

    const review = modelForKind(original.form, "review", autofillContext);
    expect(review.form.reviewedEventId).toBe("result-current");
    expect(review.notice).toContain("판독 대상(직전 행)");
  });

  it("활성 타석이 없으면 직전 결과의 다음 명단 타자와 명시된 투수를 지정한다", () => {
    const document = fixture();
    const unresolved = eventOfKind(document, "unresolved");
    const currentSession = session(document, [context(unresolved, state())]);
    const request = { mode: "replace_event" as const, eventId: unresolved.identity.eventId };
    const autofillContext = buildEditorAutofillContext(currentSession, request);

    const result = modelForKind(formFrom(request, unresolved), "batter_start", autofillContext);

    expect(result.form).toMatchObject({
      batterId: "runner-first",
      pitcherId: "pitcher-current",
    });
    expect(result.notice).toContain("타자(명단 다음 타순)");
    expect(result.notice).toContain("투수(직전 행)");

    const changed = invalidateContextAssignments(result, { inning: "2" }, autofillContext);
    expect(changed.form).toMatchObject({ batterId: "", pitcherId: "" });
    expect(changed.assignments).toEqual({});
  });

  it("앞선 명시적 교체가 다음 타순 선수를 바꾼 경우 교체 선수를 지정한다", () => {
    const base = fixture();
    const unresolved = eventOfKind(base, "unresolved");
    const document = parseStagingGameDocumentV2({
      ...base,
      events: [
        ...base.events.slice(0, 3),
        sourceEvent("lineup-change", 3, "substitution", {
          side: "away",
          role: "batter",
          incomingPlayerId: "incoming-away",
          outgoingPlayerId: "runner-first",
          battingOrder: 2,
        }),
        {
          ...unresolved,
          identity: { ...unresolved.identity, eventIndex: 4 },
          sequence: 4,
        },
      ],
    });
    const target = eventOfKind(document, "unresolved");
    const currentSession = session(document, [context(target, state())]);
    const request = { mode: "replace_event" as const, eventId: target.identity.eventId };
    const autofillContext = buildEditorAutofillContext(currentSession, request);

    const result = modelForKind(formFrom(request, target), "batter_start", autofillContext);

    expect(result.form.batterId).toBe("incoming-away");
    expect(result.assignments.batterId?.reason).toBe("앞선 교체 타순");
  });

  it("주자와 출발 베이스를 양방향으로 맞추고 득점·홈 관계를 정리한다", () => {
    const document = fixture();
    const result = eventOfKind(document, "plate_result");
    const next = eventOfKind(document, "unresolved");
    const currentSession = session(document, [
      context(result, state({ bases: ["runner-first", "runner-second", "runner-third"] })),
    ]);
    const request = {
      mode: "add_event" as const,
      beforeEventId: next.identity.eventId,
      seedEvent: result,
    };
    const autofillContext = buildEditorAutofillContext(currentSession, request);
    const initial = initialEditorModel(request, undefined, autofillContext);
    const second = runnerBaseModel(initial, "2", autofillContext);
    expect(second.form).toMatchObject({ fromBase: "2", runnerId: "runner-second" });

    const third = runnerPlayerModel(second, "runner-third", autofillContext);
    expect(third.form.fromBase).toBe("3");
    expect(third.assignments.fromBase?.reason).toBe("현재 베이스");

    const scored = runnerOutcomeModel(third, "scored");
    expect(scored.form).toMatchObject({ outcome: "scored", toBase: "4" });
    const backToThird = runnerDestinationModel(scored, "3");
    expect(backToThird.form).toMatchObject({ outcome: "safe", toBase: "3" });
  });

  it("교체 역할에 따라 팀·나가는 선수·명시된 타순을 다시 지정한다", () => {
    const document = fixture();
    const unresolved = eventOfKind(document, "unresolved");
    const currentSession = session(document, [
      context(
        unresolved,
        state({
          batterId: "batter-current",
          pitcherId: "pitcher-current",
          bases: ["runner-first", "runner-second", null],
        }),
      ),
    ]);
    const request = { mode: "replace_event" as const, eventId: unresolved.identity.eventId };
    const autofillContext = buildEditorAutofillContext(currentSession, request);
    const base = formFrom(request, unresolved);
    const batter = modelForKind(base, "substitution", autofillContext);
    expect(batter.form).toMatchObject({
      side: "away",
      role: "batter",
      outgoingPlayerId: "batter-current",
      battingOrder: "1",
      incomingPlayerId: "",
    });

    const pitcher = substitutionRoleModel(batter, "pitcher", autofillContext);
    expect(pitcher.form).toMatchObject({
      side: "home",
      role: "pitcher",
      outgoingPlayerId: "pitcher-current",
      battingOrder: "",
      incomingPlayerId: "",
    });

    const runner = substitutionRoleModel(pitcher, "runner", autofillContext);
    expect(runner.form).toMatchObject({
      side: "away",
      outgoingPlayerId: "runner-first",
      battingOrder: "2",
    });
    const otherRunner = substitutionOutgoingModel(runner, "runner-second", autofillContext);
    expect(otherRunner.form.battingOrder).toBe("3");
  });

  it("상위 선택 변경은 종속값을 지우고 command 방어가 오래된 값을 제외한다", () => {
    const document = fixture();
    const result = eventOfKind(document, "plate_result");
    const current = {
      ...formFrom({ mode: "replace_event", eventId: result.identity.eventId }, result),
      creditedRbi: "2",
      outsRecorded: "2",
      batterDestination: "3",
      battedBallType: "ground_ball",
      isBunt: "false",
    };
    expect(resultDefaults("strikeout")).toEqual({
      result: "strikeout",
      creditedRbi: "",
      outsRecorded: "",
      batterDestination: "",
      battedBallType: "",
      isBunt: "",
    });

    const runnerForm = {
      ...current,
      kind: "runner_advance" as const,
      relayText: "3루주자 비식별 선수 : 홈인",
      runnerId: "runner-third",
      fromBase: "3",
      toBase: "2",
      outcome: "scored",
      outKind: "force",
      supersedesThirdOut: true,
      contextKind: "independent" as const,
      reason: "other",
    };
    const runnerEvent = eventFromForm(runnerForm, document, undefined);
    expect(runnerEvent?.kind).toBe("runner_advance");
    if (runnerEvent?.kind !== "runner_advance") return;
    expect(runnerEvent.payload.toBase).toBe(4);
    expect(runnerEvent.payload).not.toHaveProperty("outKind");
    expect(runnerEvent.payload).not.toHaveProperty("supersedesThirdOut");
  });

  it("이닝 변경은 compiler 위치에서 자동 지정된 값만 제거한다", () => {
    const document = fixture();
    const unresolved = eventOfKind(document, "unresolved");
    const currentSession = session(document, [
      context(unresolved, state({ batterId: "batter-current", pitcherId: "pitcher-current" })),
    ]);
    const request = { mode: "replace_event" as const, eventId: unresolved.identity.eventId };
    const autofillContext = buildEditorAutofillContext(currentSession, request);
    const result = modelForKind(formFrom(request, unresolved), "plate_result", autofillContext);
    const changed = invalidateContextAssignments(result, { inning: "2" }, autofillContext);
    expect(changed.form).toMatchObject({ inning: "2", batterId: "", pitcherId: "" });
    expect(changed.assignments).toEqual({});
  });
});

function fixture(): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "anonymous-autofill-game",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "anonymous-autofill-game",
      season: 2026,
      gameDate: "2026-08-20",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "ANON-AWAY", name: "비식별 원정팀" },
      home: { teamId: "ANON-HOME", name: "비식별 홈팀" },
    },
    rosters: {
      away: {
        teamId: "ANON-AWAY",
        players: [
          player("batter-current", "현재 타자", 1, ["타자"]),
          player("runner-first", "1루 주자", 2, ["내야수"]),
          player("runner-second", "2루 주자", 3, ["외야수"]),
          player("runner-third", "3루 주자", 4, ["내야수"]),
          player("incoming-away", "교체 후보", undefined, ["타자"]),
        ],
      },
      home: {
        teamId: "ANON-HOME",
        players: [
          player("pitcher-current", "현재 투수", undefined, ["투수"]),
          player("incoming-home", "투수 후보", undefined, ["투수"]),
        ],
      },
    },
    events: [
      sourceEvent("half-start", 0, "half_inning_start", {}),
      sourceEvent("batter-start", 1, "batter_start", {
        batterId: "batter-current",
        pitcherId: "pitcher-current",
      }),
      sourceEvent("result-current", 2, "plate_result", {
        result: "single",
        batterId: "batter-current",
        pitcherId: "pitcher-current",
      }),
      sourceEvent("unresolved-current", 3, "unresolved", { sourceType: "unknown" }),
    ],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}

function player(
  playerId: string,
  name: string,
  battingOrder: number | undefined,
  positions: string[],
) {
  return {
    playerId,
    name,
    ...(battingOrder === undefined ? {} : { battingOrder }),
    starter: true,
    positions,
  };
}

function sourceEvent(
  eventId: string,
  sequence: number,
  kind: StagingRelayEvent["kind"],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    identity: {
      kind: "source",
      eventId,
      endpoint: "anonymous-relay",
      blockIndex: 0,
      eventIndex: sequence,
    },
    sequence,
    inning: 1,
    half: "top",
    relayText: `비식별 중계 ${String(sequence)}`,
    kind,
    payload,
  };
}

function eventOfKind<K extends StagingRelayEvent["kind"]>(
  document: StagingGameDocumentV2,
  kind: K,
): Extract<StagingRelayEvent, { kind: K }> {
  const event = document.events.find((candidate) => candidate.kind === kind);
  if (event === undefined) throw new Error(`${kind} fixture missing`);
  return event as Extract<StagingRelayEvent, { kind: K }>;
}

function state(
  patch: Partial<CorrectionEventContext["before"]> = {},
): CorrectionEventContext["before"] {
  return {
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [null, null, null],
    awayScore: 0,
    homeScore: 0,
    batterId: null,
    pitcherId: null,
    ...patch,
  };
}

function context(
  event: StagingRelayEvent,
  before: CorrectionEventContext["before"],
): CorrectionEventContext {
  return {
    eventId: event.identity.eventId,
    applied: true,
    before,
    after: before,
  };
}

function session(
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[],
): CorrectionSession {
  return {
    sessionId: "anonymous-session",
    authority: "quarantine",
    gameId: document.metadata.gameId,
    baseDocumentHash: "0".repeat(64),
    sessionVersion: 0,
    draftDocumentHash: "1".repeat(64),
    draftDocument: document,
    storedFindings: [],
    findings: [],
    eventContexts: [...eventContexts],
    calculatedRecords: { batters: [], pitchers: [] },
    blockingCount: 0,
    warningCount: 0,
    canUndo: false,
    canRedo: false,
    dirty: false,
  };
}
