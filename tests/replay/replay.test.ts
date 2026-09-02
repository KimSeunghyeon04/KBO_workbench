import { readFile } from "node:fs/promises";

import {
  parseReplayFrame,
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import { buildReplayBundle, type ReplaySourceData } from "@kbo/replay";
import { beforeAll, describe, expect, it } from "vitest";

describe("DB typed fact replay builder", () => {
  let document: StagingGameDocumentV2;

  beforeAll(async () => {
    document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
  });

  it("같은 compiled fact에서 결정적인 manifest와 원자적 play frame을 만든다", () => {
    const first = bundle(document);
    const second = bundle(document);
    expect(first).toEqual(second);
    expect(first.manifest.frameCount).toBe(compileStagingGameDocumentV2(document).plays.length);
    expect(first.frames.some((frame) => frame.relayEvents.length > 1)).toBe(true);
  });

  it("DB typed movement를 선수 정보와 source/derived provenance를 보존해 frame에 싣는다", () => {
    const replay = bundle(document);
    const movements = replay.frames.flatMap((frame) => frame.movements);
    expect(movements.length).toBeGreaterThan(0);
    expect(movements.some((movement) => movement.derived && movement.sourceEventId === null)).toBe(
      true,
    );
    expect(movements.some((movement) => !movement.derived && movement.sourceEventId !== null)).toBe(
      true,
    );
    expect(movements.every((movement) => movement.runner.name.length > 0)).toBe(true);
    expect(movements.every((movement) => movement.responsiblePitcher.name.length > 0)).toBe(true);
  });

  it("movement를 포함한 replay frame을 strict decode한다", () => {
    const frame = bundle(document).frames.find((item) => item.movements.length > 0);
    if (frame === undefined) throw new Error("movement frame fixture가 필요합니다.");
    expect(parseReplayFrame(frame)).toEqual(frame);
    const movement = frame.movements[0];
    if (movement === undefined) throw new Error("movement fixture가 필요합니다.");
    expect(() =>
      parseReplayFrame({
        ...frame,
        movements: [{ ...movement, unexpected: true }],
      }),
    ).toThrow();
  });

  it("동일 sourcePitchId의 tracking 관측을 제거하지 않고 각각 원장 행에 연결한다", () => {
    const replay = bundle(document);
    const linked = replay.frames.flatMap((frame) => frame.tracking);
    expect(linked.filter((item) => item.sourcePitchId === "p-duplicate")).toHaveLength(2);
    expect(new Set(linked.map((item) => item.trackingId))).toEqual(new Set(["t1", "t2"]));
  });

  it("공급자 PTS 순번이 없어도 linked tracking을 replay에 보존한다", () => {
    const withoutProviderOrdinal = parseStagingGameDocumentV2({
      ...document,
      trackingCandidates: document.trackingCandidates.map((item, index) =>
        index === 0 ? { ...item, sourcePitchOrdinal: null } : item,
      ),
    });
    const linked = bundle(withoutProviderOrdinal).frames.flatMap((frame) => frame.tracking);

    expect(linked.find((item) => item.trackingId === "t1")).toMatchObject({
      sourcePitchOrdinal: null,
    });
  });

  it("투수 교체 play 뒤 수비 명단과 현재 투수를 frame에 반영한다", () => {
    const substitution = manualSubstitution(8);
    const changed = parseStagingGameDocumentV2({
      ...document,
      events: [...document.events.slice(0, 8), substitution],
    });
    const frame = bundle(changed).frames.at(-1);
    expect(frame?.after.activePitchers.home?.playerId).toBe("hp2");
    expect(frame?.fielders.some((fielder) => fielder.player.playerId === "hp2")).toBe(true);
  });

  it("종료 결과가 없는 partial PA의 투구와 열린 상태를 보존한다", () => {
    const partial = parseStagingGameDocumentV2({
      ...document,
      events: document.events.slice(0, 4),
    });
    const replay = bundle(partial);
    expect(replay.manifest.finalState.plateAppearance?.batter.playerId).toBe("a1");
    expect(replay.manifest.finalState.plateAppearance?.actualPitchCount).toBe(2);
  });

  it("미연결 tracking 후보를 공개 replay에 노출하지 않는다", () => {
    const withUnlinked = parseStagingGameDocumentV2({
      ...document,
      trackingCandidates: document.trackingCandidates.map((item, index) =>
        index === 0 ? { ...item, resolution: { kind: "pending" } } : item,
      ),
    });
    expect(bundle(withUnlinked).manifest.unlinkedTracking).toEqual([]);
    expect(bundle(withUnlinked).frames.flatMap((frame) => frame.tracking)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ trackingId: "t1" })]),
    );
  });
});

function bundle(document: StagingGameDocumentV2) {
  return buildReplayBundle({
    source: sourceData(document),
    compiled: compileStagingGameDocumentV2(document),
    revision: 1,
    documentHash: stagingDocumentHash(document),
    projectionHash: "a".repeat(64),
  });
}

function sourceData(document: StagingGameDocumentV2): ReplaySourceData {
  return {
    gameId: document.metadata.gameId,
    gameDate: document.metadata.gameDate,
    status: document.metadata.status,
    teams: document.teams,
    rosters: Object.fromEntries(
      (["away", "home"] as const).map((side) => [
        side,
        document.rosters[side].players.map((player) => ({
          playerId: player.playerId,
          name: player.name,
          battingOrder: player.battingOrder ?? null,
          starter: player.starter,
          positions: player.positions,
        })),
      ]),
    ) as ReplaySourceData["rosters"],
    relayEvents: document.events.map((event) => ({
      eventId: event.identity.eventId,
      sequence: event.sequence,
      kind: event.kind,
      relayText: event.relayText ?? null,
      substitution: event.kind === "substitution" ? event.payload : null,
    })),
    trackingCandidates: document.trackingCandidates,
  };
}

function manualSubstitution(sequence: number) {
  return {
    identity: { kind: "manual" as const, eventId: "018f0000-0000-7000-8000-000000000001" },
    sequence,
    inning: 1,
    half: "top" as const,
    relayText: "투수 교체",
    kind: "substitution" as const,
    payload: {
      side: "home" as const,
      role: "pitcher" as const,
      incomingPlayerId: "hp2",
      outgoingPlayerId: "hp1",
    },
  };
}
