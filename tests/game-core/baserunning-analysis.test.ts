import { expect, it } from "vitest";
import { baserunningOpportunities, summarizeBaserunningOpportunities } from "@kbo/game-core";
import { analysisPlay, analysisState, analysisMovement } from "../helpers/analysis-play.js";
const runner = { runnerId: "r", pitcherId: "p" };
it("counts held runners and multi-step advances once per atomic play", () => {
  const before = analysisState({ bases: [runner, null, null] });
  const held = analysisPlay({ before, after: before });
  const multi = analysisPlay({
    playId: "multi",
    before,
    after: analysisState({ bases: [null, null, runner] }),
    movements: [analysisMovement(), analysisMovement({ sequence: 1, fromBase: 2, toBase: 3 })],
  });
  const rows = baserunningOpportunities([held, multi], "r");
  expect(rows.map((r) => r.outcome)).toEqual(["extra_base", "no_extra_base"]);
  expect(summarizeBaserunningOpportunities(rows)).toEqual({
    candidates: 2,
    eligible: 2,
    extraBase: 1,
    noExtraBase: 1,
    out: 0,
    unknown: 0,
    excludedComplex: 0,
    extraBaseRate: 0.5,
  });
});
it("preserves runner identity, outs and cancelled/ambiguous scoring without recomputing rules", () => {
  const before = analysisState({ bases: [null, runner, null] });
  const scored = analysisPlay({
    before,
    after: analysisState({ awayScore: 1 }),
    movements: [analysisMovement({ fromBase: 2, toBase: 4, outcome: "scored" })],
  });
  expect(baserunningOpportunities([scored], "r")[0]?.outcome).toBe("extra_base");
  expect(baserunningOpportunities([scored], "sub")).toEqual([]);
  expect(
    baserunningOpportunities([{ ...scored, after: analysisState({ outs: 3 }) }], "r")[0]?.outcome,
  ).toBe("unknown");
  const out = {
    ...scored,
    movements: [analysisMovement({ fromBase: 2, toBase: 4, outcome: "out" })],
  };
  expect(baserunningOpportunities([out], "r")[0]?.outcome).toBe("out");
  const complex = { ...scored, movements: [analysisMovement({ reason: "error" })] };
  const rows = baserunningOpportunities([complex], "r");
  expect(rows[0]?.outcome).toBe("excluded_complex");
  expect(summarizeBaserunningOpportunities(rows).eligible).toBe(0);
  expect(baserunningOpportunities([{ ...scored, result: "fielder_choice" }], "r")).toEqual([]);
});
