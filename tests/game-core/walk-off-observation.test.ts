import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  parseStagingGameDocumentV2,
  parseStagingRelayEvent,
  type StagingGameDocumentV2,
  type StagingRelayEvent,
} from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import { loadedBasesWithTwoOuts, makeDocument } from "../helpers/game-document.js";

// 검토 경기의 마지막 안타·득점·종료 관측을 선수/팀 식별 없이 축약한 원문이다.
const rows = Value.Decode(
  Type.Array(Type.Record(Type.String(), Type.Unknown())),
  JSON.parse(
    await readFile("tests/fixtures/correction/walk-off-bases.anonymized.json", "utf8"),
  ) as unknown,
);
const prefix = parseStagingGameDocumentV2(makeDocument(loadedBasesWithTwoOuts(), "final"));
const opening = parseStagingGameDocumentV2(
  makeDocument([
    { kind: "half_inning_start", payload: {} },
    ...["h1", "h2", "h3"].flatMap((batterId) => [
      { kind: "batter_start", payload: { batterId, pitcherId: "ar1" } },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId, pitcherId: "ar1", creditedRbi: 0 },
      },
    ]),
  ]),
).events.map((event) => ({
  ...event,
  identity: { ...event.identity, eventId: `opening-${event.identity.eventId}` },
}));
const source = parseStagingGameDocumentV2({
  ...prefix,
  metadata: { ...prefix.metadata, scheduledInnings: 1 },
  rosters: {
    away: { ...prefix.rosters.home, teamId: prefix.teams.away.teamId },
    home: { ...prefix.rosters.away, teamId: prefix.teams.home.teamId },
  },
  events: [
    ...opening,
    ...prefix.events.map((event) => ({ ...event, half: "bottom" })),
    ...rows.map((row, index) => ({
      ...row,
      identity: {
        kind: "source",
        eventId: `walkoff-${String(index)}`,
        endpoint: "anonymous-relay",
        blockIndex: 0,
        eventIndex: index,
      },
      sequence: prefix.events.length + index,
      inning: 1,
      half: "bottom",
    })),
  ].map((event, sequence) => ({ ...event, sequence })),
});

function correctRunners(document = source) {
  return applyCorrectionCommand(document, {
    kind: "correction_batch",
    commandId: "complete-walkoff-runners",
    commands: [
      { runnerId: "a3", fromBase: 1, toBase: 2 },
      { runnerId: "a2", fromBase: 2, toBase: 3 },
    ].map((movement, index) => ({
      kind: "add_event" as const,
      commandId: `runner-${String(index)}`,
      beforeEventId: "walkoff-1",
      event: parseStagingRelayEvent({
        identity: {
          kind: "manual",
          eventId: `0198f1e2-7d2a-7000-8000-00000000000${String(index)}`,
        },
        sequence: 0,
        inning: 1,
        half: "bottom",
        kind: "runner_advance",
        relayText: `${movement.runnerId} : 확인된 다음 베이스 진루`,
        payload: {
          ...movement,
          outcome: "safe",
          context: { kind: "plate_result", plateResultEventId: "walkoff-0" },
        },
      }),
    })),
  });
}

function alter(document: StagingGameDocumentV2, transform: (event: StagingRelayEvent) => unknown) {
  return parseStagingGameDocumentV2({ ...document, events: document.events.map(transform) });
}

function mismatches(document: StagingGameDocumentV2) {
  return compileStagingGameDocumentV2(document).findings.filter(
    (finding) => finding.code === "source_observation_mismatch",
  );
}

describe("끝내기 보정 뒤 잔루 관측 경계", () => {
  it("누락 이동은 계속 차단하고 명시적 교정 뒤에만 끝내기를 인정한다", () => {
    const before = compileStagingGameDocumentV2(source);
    expect(before.findings.map((finding) => finding.code)).toContain("runner_destination_occupied");
    expect(before.finalState.homeScore).toBe(0);

    const hash = stagingDocumentHash(source);
    const { document, replay } = correctRunners();
    expect(replay.findings).toEqual([]);
    expect(replay.finalState).toMatchObject({ homeScore: 1, awayScore: 0, outs: 2 });
    expect(replay.finalState.bases.map((base) => base?.runnerId)).toEqual(["a6", "a3", "a2"]);
    expect(replay.batterLines.find((line) => line.playerId === "a6")).toMatchObject({
      atBats: 1,
      hits: 1,
      runsBattedIn: 1,
    });
    expect(replay.pitcherLines.find((line) => line.playerId === "hp1")).toMatchObject({
      battersFaced: 6,
      hits: 1,
      runs: 1,
    });
    for (const original of source.events) {
      expect(
        document.events.find((event) => event.identity.eventId === original.identity.eventId),
      ).toEqual({ ...original, sequence: expect.any(Number) });
    }
    expect(stagingDocumentHash(source)).toBe(hash);
    expect(compileStagingGameDocumentV2(document)).toEqual(replay);
  });

  it.each(["outs", "homeScore", "awayScore"] as const)(
    "끝내기에서도 %s 관측의 차단 검증은 유지한다",
    (field) => {
      const document = alter(correctRunners().document, (event) =>
        event.identity.eventId === "walkoff-1"
          ? { ...event, observedStateAfter: { ...event.observedStateAfter, [field]: 9 } }
          : event,
      );
      expect(mismatches(document)).toContainEqual(
        expect.objectContaining({
          eventId: "walkoff-1",
          severity: "blocking",
          details: [expect.objectContaining({ field })],
        }),
      );
    },
  );

  it.each(["early", "top", "suspended", "tied", "later-play"])(
    "끝내기 조건이 아닌 %s에서는 베이스 불일치를 유지한다",
    (scenario) => {
      let document = correctRunners().document;
      if (scenario === "early") {
        document = parseStagingGameDocumentV2({
          ...document,
          metadata: { ...document.metadata, scheduledInnings: 9 },
        });
      } else if (scenario === "top") {
        document = parseStagingGameDocumentV2({
          ...document,
          rosters: prefix.rosters,
          events: document.events
            .filter((event) => !event.identity.eventId.startsWith("opening-"))
            .map((event, sequence) => ({ ...event, sequence, half: "top" })),
        });
      } else if (scenario === "suspended") {
        document = parseStagingGameDocumentV2({
          ...document,
          metadata: { ...document.metadata, status: "suspended" },
        });
      } else if (scenario === "tied") {
        const lead = makeDocument([
          { kind: "batter_start", payload: { batterId: "h1", pitcherId: "ar1" } },
          {
            kind: "plate_result",
            payload: { result: "home_run", batterId: "h1", pitcherId: "ar1", creditedRbi: 1 },
          },
        ]);
        document = parseStagingGameDocumentV2({
          ...document,
          events: [
            ...document.events.slice(0, 1),
            ...parseStagingGameDocumentV2(lead).events.map((event) => ({
              ...event,
              identity: { ...event.identity, eventId: `lead-${event.identity.eventId}` },
            })),
            ...document.events.slice(1),
          ].map((event, sequence) => ({ ...event, sequence })),
        });
      } else {
        document = parseStagingGameDocumentV2({
          ...document,
          events: [
            ...document.events,
            {
              ...source.events[0],
              identity: { kind: "manual", eventId: "0198f1e2-7d2a-7000-8000-000000000010" },
              sequence: document.events.length,
              kind: "batter_start",
              relayText: "후속 타석",
              payload: { batterId: "a7", pitcherId: "hp1" },
            },
          ],
        });
      }
      expect(mismatches(document)).toContainEqual(
        expect.objectContaining({
          eventId: "walkoff-1",
          details: expect.arrayContaining([expect.objectContaining({ field: "bases.3" })]),
        }),
      );
    },
  );

  it("독립 주루로 끝난 경기에도 같은 잔루 비교 경계를 적용한다", () => {
    const document = correctRunners().document;
    const independent = alter(document, (event) =>
      event.kind === "runner_advance" &&
      event.payload.context.kind === "plate_result" &&
      event.payload.context.plateResultEventId === "walkoff-0"
        ? {
            ...event,
            ...(event.observedStateAfter === undefined
              ? {}
              : { observedStateAfter: { ...event.observedStateAfter, balls: 0, strikes: 0 } }),
            payload: { ...event.payload, context: { kind: "independent", reason: "wild_pitch" } },
          }
        : event,
    );
    const replay = compileStagingGameDocumentV2({
      ...independent,
      events: independent.events
        .filter((event) => event.identity.eventId !== "walkoff-0")
        .map((event, sequence) => ({ ...event, sequence })),
    });
    expect(replay.findings).toEqual([]);
    expect(replay.plateAppearances.at(-1)?.terminationReason).toBe("walk_off");
    expect(replay.finalState.bases.map((base) => base?.runnerId ?? null)).toEqual([
      null,
      "a3",
      "a2",
    ]);
  });
});
