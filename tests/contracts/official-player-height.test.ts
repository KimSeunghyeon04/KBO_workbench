import { describe, expect, it } from "vitest";
import { parseOfficialPlayerHeights } from "@kbo/contracts";

const row = {
  season: 2021,
  playerId: "a1",
  playerName: "익명",
  birthDate: "1991-03-26",
  heightCm: 183,
  reportedValue: 72,
  reportedUnit: "inch",
  sourceUrl: "https://example.test/player/1",
  sourcePlayerId: "1",
  checkedOn: "2026-09-16",
};
describe("reviewed official height evidence", () => {
  it("preserves the reported unit and requires the declared nearest-cm conversion", () => {
    expect(parseOfficialPlayerHeights([row])).toEqual([row]);
    expect(() => parseOfficialPlayerHeights([{ ...row, heightCm: 180 }])).toThrow(/환산/);
  });
  it("rejects duplicate identities, undeclared properties, invalid heights and untrusted URL schemes", () => {
    expect(() => parseOfficialPlayerHeights([row, row])).toThrow(/중복/);
    for (const change of [
      { heightCm: 0 },
      { heightCm: 182.88 },
      { topSz: 1 },
      { sourceUrl: "file:///secret" },
    ])
      expect(() => parseOfficialPlayerHeights([{ ...row, ...change }])).toThrow();
  });
});
