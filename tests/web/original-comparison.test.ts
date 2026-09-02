import { readFile } from "node:fs/promises";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { describe, expect, it } from "vitest";

import { compareWithOriginal } from "../../apps/web/src/correction/original-comparison.js";

describe("최초 수집본 비교", () => {
  it("eventId 기준 추가·삭제·내용·순서와 관계형 영역 변경을 구분한다", async () => {
    const original = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const moved = applyCorrectionCommand(original, {
      commandId: "compare-move",
      kind: "move_event",
      eventId: "e4",
      beforeEventId: "e2",
    }).document;
    const changed = parseStagingGameDocumentV2({
      ...moved,
      events: moved.events.map((event) => {
        if (event.identity.eventId === "e5") return { ...event, relayText: "수집된 중계 문구" };
        if (event.identity.eventId === "e17" && event.kind === "plate_result") {
          return {
            ...event,
            relayText: "타자4 : 좌중간 홈런",
            payload: { ...event.payload, battedBallType: "fly_ball" as const, isBunt: false },
          };
        }
        return event;
      }),
      rosters: {
        ...moved.rosters,
        away: {
          ...moved.rosters.away,
          players: moved.rosters.away.players.map((player, index) =>
            index === 0 ? { ...player, name: "수정 선수" } : player,
          ),
        },
      },
    });

    const comparison = compareWithOriginal(original, changed);
    expect(comparison.eventCounts.changed).toBe(2);
    expect(comparison.eventCounts.moved).toBeGreaterThan(0);
    expect(comparison.rosterChanges).toBe(1);
    expect(comparison.events.find((item) => item.eventId === "e5")).toMatchObject({
      kind: "changed",
      currentText: "수집된 중계 문구",
    });
    expect(comparison.events.find((item) => item.eventId === "e17")?.kind).toBe("changed");
  });
});
