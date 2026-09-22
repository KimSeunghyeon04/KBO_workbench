import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractNaverPlayerHeights } from "@kbo/collection";

const context = { gameId: "anonymous-heights", season: 2022, sourceBundleHash: "a".repeat(64) };
describe("Naver player heights", () => {
  it("recovers the omitted nested player record with its exact source and no PTS fallback", async () => {
    const payloads: Record<string, unknown> = JSON.parse(
      await readFile("tests/fixtures/naver/player-height-nested.anonymized.json", "utf8"),
    );
    const result = extractNaverPlayerHeights({ ...context, payloads });
    expect(result.observations).toEqual([
      {
        playerId: "anonymous-batter",
        heightCm: null,
        rawHeight: "0.0",
        endpoint: "relay_009",
        sourcePath: "result.textRelayData.awayLineup.batter[0].height",
      },
      {
        playerId: "anonymous-batter",
        heightCm: 185,
        rawHeight: "185.0",
        endpoint: "relay_009",
        sourcePath: "result.textRelayData.textRelays[0].textOptions[0].batterRecord.height",
      },
      {
        playerId: "anonymous-pitcher",
        heightCm: 190,
        rawHeight: "190.0",
        endpoint: "relay_009",
        sourcePath: "result.textRelayData.textRelays[0].textOptions[1].pitcherRecord.height",
      },
    ]);
  });
  it("reads saved lineup and relay substitutes, preserves source paths, and ignores PTS", async () => {
    const payloads = JSON.parse(
      await readFile("tests/fixtures/naver/player-height.anonymized.json", "utf8"),
    ) as Record<string, unknown>;
    const result = extractNaverPlayerHeights({ ...context, payloads });
    expect(
      result.observations.filter((o) => o.heightCm !== null).map((o) => [o.playerId, o.heightCm]),
    ).toEqual([
      ["a1", 185],
      ["h1", 190],
      ["a2", 178],
    ]);
    expect(
      result.observations.find((o) => o.playerId === "a2" && o.heightCm === 178),
    ).toMatchObject({
      endpoint: "relay_summary",
      sourcePath: "result.textRelayData.awayLineup.batter[0].height",
      rawHeight: "178.0",
    });
    expect(
      extractNaverPlayerHeights({
        ...context,
        payloads: Object.fromEntries(Object.entries(payloads).reverse()),
      }),
    ).toEqual(result);
  });
  it("preserves conflicting, missing and invalid evidence instead of guessing", () => {
    const rows = [
      { pcode: "a1", height: "185.0" },
      { pcode: "a1", height: "180.0" },
      { pcode: "a2", height: "0" },
      { pcode: "a3", height: "180cm" },
      { pcode: "a4" },
      { name: "익명", height: "180.0" },
    ];
    const result = extractNaverPlayerHeights({
      ...context,
      payloads: { relay_summary: { result: { textRelayData: { awayLineup: { batter: rows } } } } },
    });
    expect(result.observations.map((o) => o.heightCm)).toEqual([185, 180, null, null, null]);
  });
  it("accepts integral cm strings with decimal notation across the valid range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 250 }), (height) => {
        const result = extractNaverPlayerHeights({
          ...context,
          payloads: {
            lineup: {
              result: {
                previewData: {
                  awayTeamLineUp: { fullLineUp: [{ playerCode: "a", height: `${height}.0` }] },
                },
              },
            },
          },
        });
        expect(result.observations[0]?.heightCm).toBe(height);
      }),
    );
  });
});
