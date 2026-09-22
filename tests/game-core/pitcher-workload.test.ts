import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PitcherWorkloadResponseSchema,
  resolveAnalysisScope,
  type WorkloadAppearance,
} from "@kbo/contracts";
import { analyzePitcherWorkload } from "@kbo/game-core";
import { analysisPlay, analysisState, analysisMovement } from "../helpers/analysis-play.js";
const query = { season: 2024, dateFrom: "2024-06-03", dateTo: "2024-06-03" },
  scope = resolveAnalysisScope(query, "regular");
function appearance(id: string, date: string, pitches = 10): WorkloadAppearance {
  return {
    gameId: id,
    revision: 1,
    gameDate: date,
    teamId: "t",
    teamName: "팀",
    side: "home",
    role: "unknown",
    pitches,
    battersFaced: 1,
    outs: 0,
  };
}
it("uses earlier calendar days across team changes and does not infer doubleheader order", () => {
  const history = [
    appearance("one", "2024-06-01"),
    { ...appearance("two", "2024-06-02", 20), teamId: "other" },
    appearance("three", "2024-06-03", 30),
    appearance("four", "2024-06-03", 5),
  ];
  const ids = new Set(["three", "four"]),
    r = analyzePitcherWorkload(query, "p", scope, "hash", history, ids, [], [], []);
  expect(Value.Check(PitcherWorkloadResponseSchema, r)).toBe(true);
  expect(r.appearances[0]).toMatchObject({
    previousObservedDate: "2024-06-02",
    observedRestDays: 0,
    previous3DaysPitches: 30,
    previous7DaysPitches: 30,
    observedConsecutiveDays: 3,
    sameDayOrder: "unknown",
    sameDayEarlierPitches: null,
  });
  expect(
    analyzePitcherWorkload(
      query,
      "p",
      scope,
      "hash",
      [...history, appearance("future", "2024-06-04", 99)],
      ids,
      [],
      [],
      [],
    ),
  ).toEqual(r);
  const first = analyzePitcherWorkload(
    { season: 2024 },
    "p",
    resolveAnalysisScope({ season: 2024 }),
    "hash",
    [history[0] ?? appearance("empty", "2024-06-01")],
    new Set(["one"]),
    [],
    [],
    [],
  );
  expect(first.appearances[0]?.observedRestDays).toBeNull();
});
it("counts actual PA encounters separately from BF and tracks inherited pinch-runner identities", () => {
  const runner = { runnerId: "original", pitcherId: "old" },
    sub = { runnerId: "sub", pitcherId: "old" };
  const plays = [
    analysisPlay({
      gameId: "g",
      sequence: 1,
      kind: "substitution",
      before: analysisState({ homePitcherId: "old", bases: [runner, null, null] }),
      after: analysisState({ homePitcherId: "p", bases: [runner, null, null] }),
    }),
    analysisPlay({
      gameId: "g",
      sequence: 2,
      kind: "substitution",
      before: analysisState({ bases: [runner, null, null] }),
      after: analysisState({ bases: [sub, null, null] }),
    }),
    analysisPlay({
      gameId: "g",
      sequence: 3,
      before: analysisState({ bases: [sub, null, null] }),
      after: analysisState({ awayScore: 1 }),
      movements: [
        analysisMovement({ runnerId: "sub", pitcherId: "old", toBase: 4, outcome: "scored" }),
      ],
    }),
  ];
  const encounters = [
    { gameId: "g", revision: 1, paId: "one", batterId: "b", firstSequence: 1, pitches: 4 },
    { gameId: "g", revision: 1, paId: "two", batterId: "b", firstSequence: 8, pitches: 3 },
  ];
  const r = analyzePitcherWorkload(
    query,
    "p",
    scope,
    "hash",
    [appearance("g", "2024-06-03")],
    new Set(["g"]),
    encounters,
    plays,
    [],
  );
  expect(r.appearances[0]?.encounters.map((e) => e.meetingNumber)).toEqual([1, 2]);
  expect(r.appearances[0]?.battersFaced).toBe(1);
  expect(r.appearances[0]?.inherited[0]).toMatchObject({
    runnerId: "original",
    currentRunnerId: "sub",
    responsiblePitcherId: "old",
    outcome: "scored_during_spell",
  });
});
