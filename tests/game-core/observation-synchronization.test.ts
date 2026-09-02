import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

const SOURCE_MISMATCH = "source_observation_mismatch";

describe("원자적 플레이 관측 경계와 종료 점수 검증", () => {
  it("마지막 연결 행에 관측값이 없으면 앞선 source 주자 스냅샷을 최종 상태와 비교하지 않는다", async () => {
    const replay = compileStagingGameDocumentV2(await fixture());

    expect(replay.finalState).toMatchObject({ awayScore: 1, homeScore: 0 });
    expect(sourceMismatches(replay)).toEqual([]);
  });

  it("마지막 source 주자 행이 원자적 플레이 전체를 관측하면 그 행에서 비교한다", async () => {
    const document = await fixture();
    const manual = eventById(document, "0198f1e2-7d2a-7000-8000-000000000099");
    const source = eventById(document, "event-14");
    const moved = resequence([
      ...document.events.slice(0, 14),
      manual,
      {
        ...source,
        observedStateAfter: {
          balls: 0,
          strikes: 0,
          outs: 2,
          bases: [true, false, true],
          awayScore: 1,
          homeScore: 0,
        },
      },
      ...document.events.slice(16),
    ]);

    expect(sourceMismatches(compileStagingGameDocumentV2(withEvents(document, moved)))).toEqual([]);
  });

  it("source 종료 관측 뒤의 수동 연결 득점도 최종 계산에 포함해 검증한다", async () => {
    const document = await fixture();
    const manual = eventById(document, "0198f1e2-7d2a-7000-8000-000000000099");
    const footer = eventById(document, "event-16");
    const moved = resequence([...document.events.slice(0, 15), footer, manual]);

    const replay = compileStagingGameDocumentV2(withEvents(document, moved));
    expect(replay.finalState.awayScore).toBe(1);
    expect(sourceMismatches(replay)).toEqual([]);
  });

  it("독립 다중 주루도 마지막 상태 변경 행에만 있는 관측값을 사용한다", async () => {
    const document = await fixture();
    const events = document.events.map((event) => {
      if (event.identity.eventId !== "event-14" && event.identity.kind !== "manual") return event;
      if (event.kind !== "runner_advance") return event;
      return {
        ...event,
        payload: {
          ...event.payload,
          context: { kind: "independent" as const, reason: "wild_pitch" as const },
        },
      };
    });

    expect(sourceMismatches(compileStagingGameDocumentV2(withEvents(document, events)))).toEqual(
      [],
    );
  });

  it("최종 점수가 다르면 종료 source 행과 점수 detail을 가진 차단 finding을 만든다", async () => {
    const document = await fixture();
    const changed = replaceEvent(document, "event-16", (event) => ({
      ...event,
      observedStateAfter: { ...event.observedStateAfter, awayScore: 2 },
    }));

    expect(sourceMismatches(compileStagingGameDocumentV2(changed))).toEqual([
      expect.objectContaining({
        eventId: "event-16",
        severity: "blocking",
        details: [{ field: "awayScore", expected: 2, actual: 1 }],
      }),
    ]);
  });

  it("최종 점수가 맞아도 앞선 투구 카운트 불일치를 제거하지 않는다", async () => {
    const document = await fixture();
    const pitch: StagingRelayEvent = parseEvent({
      identity: {
        kind: "source",
        eventId: "event-count-mismatch",
        endpoint: "anonymous-relay",
        blockIndex: 0,
        eventIndex: 99,
      },
      sequence: 13,
      inning: 1,
      half: "top",
      kind: "pitch",
      payload: { call: "ball", batterId: "away-5", pitcherId: "home-pitcher" },
      observedStateAfter: {
        balls: 2,
        strikes: 0,
        outs: 1,
        bases: [true, true, true],
        awayScore: 0,
        homeScore: 0,
      },
    });
    const events = resequence([
      ...document.events.slice(0, 13),
      pitch,
      ...document.events.slice(13),
    ]);

    expect(sourceMismatches(compileStagingGameDocumentV2(withEvents(document, events)))).toEqual([
      expect.objectContaining({
        eventId: "event-count-mismatch",
        details: [{ field: "balls", expected: 2, actual: 1 }],
      }),
    ]);
  });

  it("final이 아니거나 양 팀 점수가 완전하지 않으면 종료 점수로 검증하지 않는다", async () => {
    const document = await fixture();
    const suspended = parseStagingGameDocumentV2({
      ...document,
      metadata: { ...document.metadata, status: "suspended" },
      events: document.events.map((event) =>
        event.identity.eventId === "event-16"
          ? { ...event, observedStateAfter: { ...event.observedStateAfter, awayScore: 9 } }
          : event,
      ),
    });
    const incomplete = replaceEvents(document, (event) => {
      if (event.identity.eventId === "event-14") {
        return {
          ...event,
          observedStateAfter: {
            balls: event.observedStateAfter?.balls,
            strikes: event.observedStateAfter?.strikes,
            outs: event.observedStateAfter?.outs,
            bases: event.observedStateAfter?.bases,
          },
        };
      }
      if (event.identity.eventId === "event-16") {
        return { ...event, observedStateAfter: { awayScore: 9 } };
      }
      return event;
    });

    expect(sourceMismatches(compileStagingGameDocumentV2(suspended))).toEqual([]);
    expect(sourceMismatches(compileStagingGameDocumentV2(incomplete))).toEqual([]);
  });

  it("종료 관측 뒤에 source 득점 행이 있으면 그 관측을 최종 점수로 간주하지 않는다", async () => {
    const document = await fixture();
    const laterScore = parseEvent({
      identity: {
        kind: "source",
        eventId: "event-later-score",
        endpoint: "anonymous-relay",
        blockIndex: 1,
        eventIndex: 0,
      },
      sequence: document.events.length,
      inning: 1,
      half: "top",
      kind: "runner_advance",
      payload: {
        runnerId: "away-2",
        fromBase: 3,
        toBase: 4,
        outcome: "scored",
        context: { kind: "independent", reason: "wild_pitch" },
      },
    });

    const replay = compileStagingGameDocumentV2(
      withEvents(document, [...document.events, laterScore]),
    );
    expect(replay.finalState.awayScore).toBe(2);
    expect(sourceMismatches(replay)).toEqual([]);
  });
});

type CompileResult = ReturnType<typeof compileStagingGameDocumentV2>;

function sourceMismatches(result: CompileResult) {
  return result.findings.filter((finding) => finding.code === SOURCE_MISMATCH);
}

async function fixture(): Promise<StagingGameDocumentV2> {
  return parseStagingGameDocumentV2(
    JSON.parse(
      await readFile("tests/fixtures/correction/observation-sync-regression.json", "utf8"),
    ) as unknown,
  );
}

function eventById(document: StagingGameDocumentV2, eventId: string): StagingRelayEvent {
  const event = document.events.find((candidate) => candidate.identity.eventId === eventId);
  if (event === undefined) throw new Error(`fixture event not found: ${eventId}`);
  return event;
}

function replaceEvent(
  document: StagingGameDocumentV2,
  eventId: string,
  transform: (event: StagingRelayEvent) => unknown,
): StagingGameDocumentV2 {
  return replaceEvents(document, (event) =>
    event.identity.eventId === eventId ? transform(event) : event,
  );
}

function replaceEvents(
  document: StagingGameDocumentV2,
  transform: (event: StagingRelayEvent) => unknown,
): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({
    ...document,
    events: document.events.map(transform),
  });
}

function withEvents(
  document: StagingGameDocumentV2,
  events: readonly unknown[],
): StagingGameDocumentV2 {
  return parseStagingGameDocumentV2({ ...document, events: resequence(events) });
}

function resequence(events: readonly unknown[]): readonly unknown[] {
  return events.map((event, sequence) => ({ ...(event as object), sequence }));
}

function parseEvent(event: unknown): StagingRelayEvent {
  const document = {
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "anonymous-event",
      collectedAt: "2026-08-29T00:00:00Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "anonymous-event",
      season: 2026,
      gameDate: "2026-08-29",
      status: "suspended",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정팀" },
      home: { teamId: "HOME", name: "홈팀" },
    },
    rosters: {
      away: { teamId: "AWAY", players: [] },
      home: { teamId: "HOME", players: [] },
    },
    events: [{ ...(event as object), sequence: 0 }],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  };
  const parsed = parseStagingGameDocumentV2(document);
  const first = parsed.events[0];
  if (first === undefined) throw new Error("event parse failed");
  return first;
}
