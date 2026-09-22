import { readFile } from "node:fs/promises";

import {
  type CorrectionEventContext,
  type CorrectionGameCatalogItem,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, type GameState } from "@kbo/game-core";
import { describe, expect, it } from "vitest";

import {
  buildCorrectionTimeline,
  buildEventPresentations,
  correctionGameLabel,
  filterCorrectionGames,
} from "../../apps/web/src/correction/event-presentation.js";

describe("보정 원장 행 표시", () => {
  it("보정 후보를 authority로 고르고 목록에는 finding 수를 표시하지 않는다", () => {
    const games: CorrectionGameCatalogItem[] = [
      catalogItem("20240404LTHH02024", "quarantine"),
      catalogItem("20240405OBLT02024", "staging"),
    ];
    expect(filterCorrectionGames(games, "review", "").map((game) => game.gameId)).toEqual([
      "20240404LTHH02024",
    ]);
    expect(correctionGameLabel(games[0] as CorrectionGameCatalogItem)).toBe(
      `${games[0]?.gameDate} ${games[0]?.teams.away.name}–${games[0]?.teams.home.name} · 검토 필요 · 20240404LTHH02024`,
    );
  });

  it("JSON 원장과 1:1인 행에 원문·구조 요약·compiler 상태를 표시한다", async () => {
    const document = await golden();
    const replay = compileStagingGameDocumentV2(document);
    const contexts: CorrectionEventContext[] = replay.plays.flatMap((play) =>
      play.relayEventIds.map((eventId) => ({
        eventId,
        applied: play.applied,
        before: state(play.before),
        after: state(play.after),
      })),
    );
    const rows = buildEventPresentations(document, contexts);
    const timeline = buildCorrectionTimeline(rows);
    expect(rows).toHaveLength(document.events.length);
    expect(timeline).toHaveLength(document.events.length);
    expect(timeline.every((row) => row.kind === "event")).toBe(true);
    expect(rows.find((row) => row.event.identity.eventId === "e1")).toMatchObject({
      title: "원정1 타석",
    });
    expect(rows.find((row) => row.event.identity.eventId === "e10")?.summary).toContain("원정2");
    expect(rows.find((row) => row.event.identity.eventId === "e11")?.summary).toContain("e10");
  });

  it("원천 ID 없는 투구를 명확하게 표시한다", async () => {
    const document = await golden();
    const pitch = document.events.find((event) => event.kind === "pitch");
    if (pitch?.kind !== "pitch") throw new Error("fixture pitch missing");
    const withoutId = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === pitch.identity.eventId
          ? { ...event, payload: { ...pitch.payload, sourcePitchId: undefined } }
          : event,
      ),
    });
    const row = buildEventPresentations(withoutId, []).find(
      (item) => item.event.identity.eventId === pitch.identity.eventId,
    );
    expect(row?.summary).toContain("ID");
  });

  it("타구 유형과 번트 여부를 구조 요약과 검색 문자열에 포함한다", async () => {
    const document = await golden();
    const changed = parseStagingGameDocumentV2({
      ...document,
      events: document.events.map((event) =>
        event.identity.eventId === "e17" && event.kind === "plate_result"
          ? {
              ...event,
              payload: { ...event.payload, battedBallType: "line_drive" as const, isBunt: true },
            }
          : event,
      ),
    });
    const row = buildEventPresentations(changed, []).find(
      (item) => item.event.identity.eventId === "e17",
    );
    expect(row?.summary).toContain("원정4");
    expect(row?.searchText).toContain("line_drive");
    expect(row?.searchText).toContain("true");
  });
});

async function golden() {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}

function state(value: GameState): CorrectionEventContext["after"] {
  return {
    balls: value.balls,
    strikes: value.strikes,
    outs: value.outs,
    bases: value.bases.map((base) => base?.runnerId ?? null),
    awayScore: value.awayScore,
    homeScore: value.homeScore,
    batterId: value.activePlateAppearance?.currentBatterId ?? null,
    pitcherId: value.activePlateAppearance?.currentPitcherId ?? null,
  };
}

function catalogItem(
  gameId: string,
  authority: CorrectionGameCatalogItem["authority"],
): CorrectionGameCatalogItem {
  return {
    gameId,
    season: 2024,
    authority,
    updatedAt: "2026-08-22T00:00:00.000Z",
    gameDate: "2024-04-04",
    teams: { away: { teamId: "away", name: "원정" }, home: { teamId: "home", name: "홈" } },
  };
}
