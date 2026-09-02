import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";

describe("평면 원장 golden compile", () => {
  it("타석 결과와 연결 주자 행을 원자적 play로 묶고 원장 행은 각각 보존한다", async () => {
    const document = await golden();
    const replay = compileStagingGameDocumentV2(document);
    const single = replay.plays.find((play) => play.relayEventIds.includes("e10"));
    const homer = replay.plays.find((play) => play.relayEventIds.includes("e17"));

    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
    expect(replay.findings.map((finding) => finding.code)).toEqual([
      "source.pitch_id.reused_within_game",
      "source.pitch_id.reused_within_game",
      "source.tracking.missing_for_pitch",
      "source.tracking.missing_for_pitch",
      "source.tracking.missing_for_pitch",
      "source.tracking.missing_for_pitch",
    ]);
    expect(replay.frames).toHaveLength(document.events.length);
    expect(single).toMatchObject({ relayEventIds: ["e10", "e11"], applied: true });
    expect(homer).toMatchObject({ relayEventIds: ["e17", "e18", "e19"], applied: true });
    expect(homer?.movements.map((movement) => [movement.runnerId, movement.derived])).toEqual([
      ["a1", false],
      ["a2", false],
      ["a4", true],
    ]);
    expect(replay.finalState).toMatchObject({ awayScore: 3, homeScore: 0, outs: 1 });
  });

  it("원장 hash와 compiler 결과가 반복 실행에서 결정적이다", async () => {
    const document = await golden();
    expect(stagingDocumentHash(document)).toMatch(/^[0-9a-f]{64}$/);
    expect(compileStagingGameDocumentV2(document)).toEqual(compileStagingGameDocumentV2(document));
  });
});

async function golden() {
  return parseStagingGameDocumentV2(
    JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
  );
}
