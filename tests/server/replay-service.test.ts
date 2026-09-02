import { readFile } from "node:fs/promises";

import { parseStagingGameDocumentV2, type StagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";
import type { ReplaySourceData } from "@kbo/replay";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { InvalidReplayCursorError, ReplayService } from "../../apps/server/src/replay-service.js";

describe("ReplayService", () => {
  let document: StagingGameDocumentV2;

  beforeAll(async () => {
    document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
  });

  it("DB typed revision으로 manifest를 만들고 revision 1을 명시한다", async () => {
    const loadCompiled = compiledStore(document);
    const service = new ReplayService({ loadCompiled } as never);
    const manifest = await service.manifest(document.metadata.gameId, 1);
    expect(manifest).toMatchObject({
      gameId: document.metadata.gameId,
      revision: 1,
      frameCount: compileStagingGameDocumentV2(document).plays.length,
    });
    expect(loadCompiled).toHaveBeenCalledWith(document.metadata.gameId, 1);
  });

  it("모든 원자적 play chunk를 누락과 중복 없이 반환한다", async () => {
    const service = new ReplayService({ loadCompiled: compiledStore(document) } as never);
    const received: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.frames(document.metadata.gameId, 1, cursor, 4);
      received.push(...page.frames.map((frame) => frame.playId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(received).toEqual(
      compileStagingGameDocumentV2(document).plays.map((play) => play.playId),
    );
    expect(new Set(received).size).toBe(received.length);
  });

  it("변조되거나 다른 revision에 묶인 cursor를 거부한다", async () => {
    const service = new ReplayService({ loadCompiled: compiledStore(document) } as never);
    const first = await service.frames(document.metadata.gameId, 1, undefined, 2);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const middle = Math.floor((cursor?.length ?? 0) / 2);
    const tampered = `${cursor?.slice(0, middle)}${cursor?.[middle] === "a" ? "b" : "a"}${cursor?.slice(middle + 1)}`;
    await expect(service.frames(document.metadata.gameId, 1, tampered, 2)).rejects.toBeInstanceOf(
      InvalidReplayCursorError,
    );
    await expect(
      service.frames(document.metadata.gameId, 2, cursor ?? undefined, 2),
    ).rejects.toThrow();
  });
});

function compiledStore(document: StagingGameDocumentV2) {
  return vi.fn(async (_gameId: string, revision = 1) => ({
    gameId: document.metadata.gameId,
    revision,
    documentHash: stagingDocumentHash(document),
    projectionHash: "b".repeat(64),
    source: sourceData(document),
    replay: compileStagingGameDocumentV2(document),
  }));
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
