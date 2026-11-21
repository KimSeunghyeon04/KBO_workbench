import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractNaverPlayerBattingProfiles } from "@kbo/collection";
import { parseGamePlayerBattingProfileDataset } from "@kbo/contracts";

const context = { gameId: "anonymous-batting", season: 2026, sourceBundleHash: "a".repeat(64) };
describe("Naver player batting profiles", () => {
  it("retains declared sides and provenance without any tracking", async () => {
    const payloads: Record<string, unknown> = JSON.parse(
      await readFile("tests/fixtures/naver/player-batting-profile.anonymized.json", "utf8"),
    );
    const result = extractNaverPlayerBattingProfiles({ ...context, payloads });
    expect(result.observations.map((o) => [o.playerId, o.battingSide])).toEqual([
      ["a1", "L"],
      ["a1", "L"],
      ["a2", "S"],
      ["h1", "R"],
    ]);
    expect(result.observations[0]).toMatchObject({
      rawValue: "좌타",
      endpoint: "lineup",
      sourcePath: "result.previewData.awayTeamLineUp.fullLineUp[0].batsThrows",
    });
    expect(
      extractNaverPlayerBattingProfiles({
        ...context,
        payloads: Object.fromEntries(Object.entries(payloads).reverse()),
      }),
    ).toEqual(result);
  });
  it("reads relay-only replacements, preserves conflicting or invalid values, and never reads PTS stance", () => {
    const result = extractNaverPlayerBattingProfiles({
      ...context,
      payloads: {
        relay_009: {
          result: {
            textRelayData: {
              awayLineup: { batter: [{ pcode: "a1", hitType: "좌투좌타" }] },
              textRelays: [
                {
                  textOptions: [
                    { batterRecord: { pcode: "a1", hitType: "우투우타" } },
                    { batterRecord: { pcode: "a2", hitType: "우투" } },
                    { batterRecord: { name: "익명", hitType: "우투좌타" } },
                    { pitcherRecord: { pcode: "h1", batsThrows: "우타" } },
                  ],
                },
              ],
              ptsOptions: [{ batterId: "a3", stance: "L" }],
            },
          },
        },
      },
    });
    expect(result.observations.map((o) => [o.playerId, o.battingSide])).toEqual([
      ["a1", "L"],
      ["a1", "R"],
      ["a2", null],
      ["h1", "R"],
    ]);
    expect(result.observations[1]?.sourcePath).toBe(
      "result.textRelayData.textRelays[0].textOptions[0].batterRecord.hitType",
    );
  });
  it("strictly decodes its boundary and rejects invented properties or sides", () => {
    const dataset = {
      ...context,
      observations: [
        {
          playerId: "a1",
          battingSide: "L",
          rawValue: "좌타",
          endpoint: "lineup",
          sourcePath: "row.hitType",
        },
      ],
    };
    expect(parseGamePlayerBattingProfileDataset(dataset)).toEqual(dataset);
    expect(() => parseGamePlayerBattingProfileDataset({ ...dataset, unknown: true })).toThrow();
    expect(() =>
      parseGamePlayerBattingProfileDataset({
        ...dataset,
        observations: [{ ...dataset.observations[0], battingSide: "left" }],
      }),
    ).toThrow();
  });
});
