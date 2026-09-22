import { readFile } from "node:fs/promises";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { normalizeNaverRelay } from "@kbo/collection";

const fixtures = Value.Decode(
  Type.Array(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  JSON.parse(
    await readFile("tests/fixtures/naver/called-game-trailing-lineup.anonymized.json", "utf8"),
  ) as unknown,
);

function normalize(blocks: readonly Record<string, unknown>[], final = true) {
  return normalizeNaverRelay({
    gameId: "anonymous-trailing-lineup",
    blocks: blocks.map((block, endpointBlockIndex) => ({
      endpoint: "relay_006",
      endpointBlockIndex,
      block,
    })),
    players: [],
    startingPitchers: { away: null, home: null },
    closeTrailingHalf: final,
  });
}

describe("검토 경기의 콜드 종료 뒤 선수 표시", () => {
  it.each(fixtures)(
    "실제 진행 없는 종료 뒤 교체·이닝·타자 표시는 원문 행으로 보존한다",
    (...blocks) => {
      const normalized = normalize(blocks);
      expect(normalized.events.every((event) => event.kind === "administrative")).toBe(true);
      expect(normalized.events[0]).toMatchObject({ payload: { code: "called_game" } });
      expect(normalized.events).toHaveLength(blocks.length);
      for (const [index, event] of normalized.events.entries()) {
        expect(event.sequence).toBe(index);
        expect(event.identity).toMatchObject({ blockIndex: index, eventIndex: 0 });
        const rows = blocks[index]?.textOptions;
        if (!Array.isArray(rows)) throw new Error("fixture 중계가 없습니다.");
        expect(event.relayText).toBe(rows[0]?.text);
      }
      expect(normalized.findings.some((finding) => finding.severity === "blocking")).toBe(false);
      expect(normalize(blocks)).toEqual(normalized);
    },
  );

  it("이후 투구가 있거나 종료 경기가 아니면 교체와 경계를 안내문으로 숨기지 않는다", () => {
    const blocks = fixtures[1];
    if (blocks === undefined) throw new Error("fixture가 없습니다.");
    const laterPitch = {
      inn: 6,
      homeOrAway: "1",
      textOptions: [{ type: 1, text: "1구 볼", seqno: 999 }],
    };
    for (const normalized of [normalize([...blocks, laterPitch]), normalize(blocks, false)]) {
      expect(normalized.events.some((event) => event.kind === "half_inning_start")).toBe(true);
      expect(normalized.findings.map((finding) => finding.code)).not.toContain(
        "source.terminal_relay_preserved",
      );
    }
  });
});
