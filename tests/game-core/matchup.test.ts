import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MatchupResponseSchema, resolveAnalysisScope } from "@kbo/contracts";
import { analyzeMatchup } from "@kbo/game-core";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
const q = { season: 2024, pitcherId: "hp1", batterId: "b1" },
  scope = resolveAnalysisScope({ season: 2024 }),
  condition = {
    pitchType: "직구",
    balls: 0,
    strikes: 0,
    stance: "R",
    speedBand: 29,
    pitches: 30,
    swings: 20,
    whiffs: 5,
    calledStrikes: 3,
  };
it("keeps direct PA attribution, similar physical pitches and exact-condition controls distinct", () => {
  const rows = [
    outcomeRow({ pitchId: "direct", swing: true, whiff: true }),
    outcomeRow({ pitchId: "similar", pitcherId: "other" }),
    outcomeRow({ pitchId: "missing", speedKph: null }),
    outcomeRow({ pitchId: "wrong-identity", batterId: "other" }),
  ];
  const r = analyzeMatchup(
    q,
    scope,
    "hash",
    rows,
    [terminalPa(), terminalPa({ paId: "other-owner", pitcherId: "other" })],
    [condition],
    [condition],
  );
  expect(Value.Check(MatchupResponseSchema, r)).toBe(true);
  expect(r.direct.pitches).toBe(2);
  expect(r.directPlateAppearances).toHaveLength(1);
  expect(r.similar.pitches).toBe(2);
  expect(r.similar.pitchers).toBe(2);
  expect(r.matched).toMatchObject({
    pitches: 2,
    swings: 1,
    leagueSwingRate: 2 / 3,
    leagueWhiffRate: 0.25,
    observedSwingRate: 0.5,
    observedWhiffRate: 1,
  });
  expect(r.excludedSimilar).toBe(1);
});
it("retains empty direct matchups and does not widen sparse or unknown conditions", () => {
  const rows = [
      outcomeRow({ pitcherId: "other" }),
      outcomeRow({ pitcherId: "other", stance: null }),
    ],
    r = analyzeMatchup(
      q,
      scope,
      "hash",
      rows,
      [],
      [condition],
      [{ ...condition, pitches: 19, swings: 5 }],
    );
  expect(r.direct.pitches).toBe(0);
  expect(r.direct.swingRate).toBeNull();
  expect(r.similar.pitches).toBe(1);
  expect(r.matched.pitches).toBe(0);
  expect(r.matched.leagueWhiffRate).toBeNull();
});
