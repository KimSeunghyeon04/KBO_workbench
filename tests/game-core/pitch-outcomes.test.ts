import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitchLocationResponseSchema,
  BatterProfileResponseSchema,
  resolveAnalysisScope,
} from "@kbo/contracts";
import {
  analyzePitchLocation,
  analyzeBatterProfile,
  observedPitchLocation,
  hasTerminalPitch,
} from "@kbo/game-core";
import { outcomeRow, terminalPa } from "../helpers/pitch-outcomes.js";
const query = { season: 2024 },
  scope = resolveAnalysisScope(query, "regular"),
  hash = "a".repeat(64);
it("separates physical pitch, swing, known zone and terminal strikeout denominators", () => {
  const rows = [
    outcomeRow({
      pitchId: "foul",
      strikes: 2,
      pitchCall: "foul",
      swing: true,
      calledStrike: false,
      csw: false,
    }),
    outcomeRow({
      pitchId: "ball",
      strikes: 2,
      pitchCall: "ball",
      inZone: false,
      calledStrike: false,
      csw: false,
    }),
    outcomeRow({
      pitchId: "p1",
      strikes: 2,
      pitchCall: "swinging_strike",
      swing: true,
      whiff: true,
      calledStrike: false,
      trackingId: null,
      inZone: null,
    }),
    outcomeRow({ pitchId: "other", strikes: 0, eligible: false }),
  ];
  const r = analyzePitchLocation(query, "hp1", scope, hash, rows, [
    terminalPa(),
    terminalPa({ paId: "automatic", pitchId: "auto", terminalActual: false }),
  ]);
  expect(Value.Check(PitchLocationResponseSchema, r)).toBe(true);
  expect(r.total).toMatchObject({
    pitches: 4,
    swings: 2,
    whiffs: 1,
    whiffRate: 0.5,
    swingingStrikeRate: 0.25,
    twoStrikePitches: 3,
    terminalStrikeouts: 1,
    putAwayRate: 1 / 3,
    zoneKnown: 3,
  });
  expect(r.coverage).toMatchObject({
    automaticStrikeouts: 1,
    locationPitches: 3,
    missingLocation: 1,
  });
  expect(r.cells.reduce((n, g) => n + g.pitches, 0)).toBe(r.points.length);
  const filtered = analyzePitchLocation(
    { ...query, cohort: "discipline" },
    "hp1",
    scope,
    hash,
    rows,
    [],
  );
  expect(filtered.total.pitches).toBe(3);
  expect(filtered.coverage.excludedSituations).toBe(1);
  expect(hasTerminalPitch(terminalPa({ afterStrikes: 2, pitchCall: "foul" }))).toBe(false);
  expect(hasTerminalPitch(terminalPa({ pitchCall: "foul_bunt", afterStrikes: 3 }))).toBe(true);
  expect(hasTerminalPitch(terminalPa({ pitchCall: "foul_tip", afterStrikes: 3 }))).toBe(true);
});
it("counts five pitches and a single completed PA without duplicating its result by type", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    outcomeRow({
      pitchId: `p${i}`,
      pitchType: i < 3 ? "직구" : "슬라이더",
      swing: i === 4,
      inPlay: i === 4,
    }),
  );
  const pas = [
    terminalPa({
      pitchId: "p4",
      pitchType: "슬라이더",
      result: "single",
      pitchCall: "in_play",
      inPlay: true,
    }),
  ];
  const r = analyzeBatterProfile(query, "b1", scope, hash, rows, pas);
  expect(Value.Check(BatterProfileResponseSchema, r)).toBe(true);
  expect(r.total).toMatchObject({ pitches: 5, inPlayResults: 1, inPlayHits: 1 });
  expect(r.plateAppearances.total).toMatchObject({ pa: 1, ab: 1, hits: 1, totalBases: 1 });
  expect(r.plateAppearances.byTerminalType).toHaveLength(1);
  expect(r.plateAppearances.byTerminalType[0]?.key).toBe("슬라이더");
  const filtered = analyzeBatterProfile(
    { ...query, pitchType: "직구" },
    "b1",
    scope,
    hash,
    rows,
    pas,
  );
  expect(filtered.total.pitches).toBe(3);
  expect(filtered.plateAppearances).toEqual(r.plateAppearances);
});
it("preserves partial, automatic, pitchless and replacement-owned PAs without inferred attribution", () => {
  const pas = [
    terminalPa({ paId: "auto", terminalActual: false }),
    terminalPa({ paId: "ibb", result: "intentional_walk", countsAsAb: false, pitchId: null }),
    terminalPa({ paId: "replacement", terminalBatterId: "other" }),
    terminalPa({
      paId: "partial",
      completed: false,
      countsAsPa: false,
      countsAsAb: false,
      result: null,
    }),
    terminalPa({ paId: "other-owner", batterId: "other", terminalBatterId: "b1" }),
  ];
  const r = analyzeBatterProfile(query, "b1", scope, hash, [], pas);
  expect(r.plateAppearances).toMatchObject({
    partial: 1,
    unattributed: 3,
    total: { pa: 3, ab: 2 },
  });
  expect(r.total.whiffRate).toBeNull();
  expect(
    analyzePitchLocation(query, "hp1", scope, hash, [], []).cells.every(
      (c) => c.whiffRate === null,
    ),
  ).toBe(true);
});
it("keeps actual location independent of missing lateral coefficients and rejects missing height", () => {
  const row = outcomeRow();
  expect(observedPitchLocation(outcomeRow({ vx0: null }))).toEqual(observedPitchLocation(row));
  expect(observedPitchLocation({ ...row, batterHeightCm: null })).toBeNull();
  expect((observedPitchLocation({ ...row, crossPlateX: 100 })?.cell ?? -1) % 5).toBe(4);
});
