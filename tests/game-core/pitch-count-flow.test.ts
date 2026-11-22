import { describe, expect, it } from "vitest";
import { analyzeBatterCountFlow, analyzePitchCountFlow } from "@kbo/game-core";
import { pitchOutcomeScope, type PitchCountFlowRow } from "@kbo/contracts";
import { countFlowRow } from "../helpers/pitch-outcomes.js";

const query = { season: 2024 };
const scope = pitchOutcomeScope(query);
const source = "a".repeat(64);
const split = (pitches: readonly PitchCountFlowRow[]) =>
  analyzePitchCountFlow(query, "hp1", scope, source, pitches).groups;
const counts = (row: ReturnType<typeof split>[number] | undefined) =>
  Object.fromEntries(row?.transitions.map((step) => [step.outcome, step.pitches]) ?? []);

describe("count transitions from physical pitches", () => {
  it("pools the batter's pitches and computes swings for the matching count, pitch and cohort", () => {
    const count = { balls: 2, strikes: 2 };
    const rows = [
      {
        ...countFlowRow({
          ...count,
          pitchId: "l",
          stance: "L",
          terminalResult: "strikeout",
          pitchCall: "swinging_strike",
        }),
        swing: true,
      },
      {
        ...countFlowRow({
          ...count,
          pitchId: "r",
          stance: "R",
          pitchCall: "called_strike",
          terminalResult: "strikeout",
        }),
        swing: false,
      },
      {
        ...countFlowRow({
          ...count,
          pitchId: "u",
          stance: null,
          pitchType: "슬라이더",
          pitchCall: "foul",
          afterStrikes: 2,
        }),
        swing: true,
      },
      {
        ...countFlowRow({
          ...count,
          pitchId: "h",
          pitchType: "슬라이더",
          terminalResult: "hit_by_pitch",
          eligible: false,
        }),
        swing: false,
      },
    ];
    const detailed = { ...query, include: "terminal-details" } as const;
    const data = analyzeBatterCountFlow(detailed, "b1", scope, source, rows);
    expect(data.groups).toHaveLength(1);
    const group = data.groups[0];
    expect(group).toMatchObject({ stance: "all", pitches: 4, swings: 2, swingRate: 0.5 });
    expect(group?.types.find((g) => g.pitchType === "슬라이더")).toMatchObject({
      pitches: 2,
      swings: 1,
      swingRate: 0.5,
      transitions: expect.arrayContaining([{ outcome: "foul", pitches: 1, rate: 0.5 }]),
    });
    expect(group?.terminalDetails).toEqual([
      { outcome: "lookingStrikeout", pitches: 1, rate: 0.25 },
      { outcome: "swingingStrikeout", pitches: 1, rate: 0.25 },
    ]);
    const discipline = analyzeBatterCountFlow(
      { ...detailed, cohort: "discipline" },
      "b1",
      scope,
      source,
      rows,
    );
    expect(discipline.excludedSituations).toBe(1);
    expect(discipline.groups[0]).toMatchObject({ pitches: 3, swings: 2, swingRate: 2 / 3 });
    expect(discipline.groups[0]?.types.find((g) => g.pitchType === "슬라이더")).toMatchObject({
      pitches: 1,
      swings: 1,
      swingRate: 1,
    });
  });

  it("pools unknown and switch sides and preserves independent count, pitch and side denominators", () => {
    const rows = [
      countFlowRow({
        pitchId: "L1",
        balls: 1,
        strikes: 2,
        afterBalls: 2,
        afterStrikes: 2,
        pitchCall: "ball",
        stance: "L",
        pitchType: "슬라이더",
        trackingId: null,
      }),
      countFlowRow({
        pitchId: "L2",
        balls: 1,
        strikes: 2,
        afterBalls: 1,
        afterStrikes: 2,
        pitchCall: "foul",
        stance: "L",
        pitchType: "직구",
      }),
      countFlowRow({
        pitchId: "R1",
        balls: 1,
        strikes: 2,
        afterBalls: 2,
        afterStrikes: 2,
        pitchCall: "ball",
        stance: "R",
        pitchType: "슬라이더",
      }),
      countFlowRow({
        pitchId: "S1",
        balls: 1,
        strikes: 2,
        afterBalls: 1,
        afterStrikes: 2,
        pitchCall: "foul",
        stance: "S",
        pitchType: "슬라이더",
      }),
      countFlowRow({
        pitchId: "N1",
        balls: 1,
        strikes: 2,
        afterBalls: 1,
        afterStrikes: 2,
        pitchCall: "foul",
        stance: null,
        pitchType: null,
        eligible: false,
      }),
      countFlowRow({
        pitchId: "L0",
        balls: 0,
        strikes: 0,
        afterBalls: 0,
        afterStrikes: 1,
        pitchCall: "foul",
        stance: "L",
        pitchType: "슬라이더",
      }),
    ];
    const data = split(rows);
    expect(split([...rows].reverse())).toEqual(data);
    const all = data.find((g) => g.stance === "all" && g.balls === 1 && g.strikes === 2);
    expect(counts(all)).toEqual({
      ball: 2,
      strike: 0,
      foul: 3,
      walk: 0,
      strikeout: 0,
      inPlay: 0,
      hitByPitch: 0,
      unresolved: 0,
    });
    const slider = all?.types.find((type) => type.pitchType === "슬라이더");
    expect(slider).toMatchObject({ pitches: 3, usageRate: 3 / 5 });
    expect(slider?.transitions.find((result) => result.outcome === "foul")).toEqual({
      outcome: "foul",
      pitches: 1,
      rate: 1 / 3,
    });
    expect(counts(data.find((g) => g.stance === "R"))).toMatchObject({ ball: 1, foul: 0 });
    expect(counts(data.find((g) => g.stance === "L" && g.balls === 0))).toMatchObject({
      strike: 1,
      foul: 0,
    });
    const limited = analyzePitchCountFlow(
      { ...query, cohort: "discipline" },
      "hp1",
      scope,
      source,
      rows,
    );
    expect(limited.excludedSituations).toBe(1);
    expect(limited.groups.filter((g) => g.stance === "all").map((g) => g.pitches)).toEqual([1, 4]);
  });

  it("uses verified terminal outcomes and the compiler's pitch state for nonterminal transitions", () => {
    const bases = { balls: 3, strikes: 2, afterBalls: 3, afterStrikes: 3 };
    const rows = [
      countFlowRow({ ...bases, pitchId: "K", pitchCall: "foul_bunt", terminalResult: "strikeout" }),
      countFlowRow({
        ...bases,
        pitchId: "B",
        pitchCall: "ball",
        afterBalls: 4,
        afterStrikes: 2,
        terminalResult: "walk",
      }),
      countFlowRow({
        ...bases,
        pitchId: "H",
        pitchCall: "in_play",
        inPlay: true,
        afterStrikes: 2,
        terminalResult: "home_run",
      }),
      countFlowRow({
        ...bases,
        pitchId: "P",
        pitchCall: "hit_by_pitch",
        afterStrikes: 2,
        terminalResult: "hit_by_pitch",
      }),
      countFlowRow({ ...bases, pitchId: "K", revision: 2, pitchCall: "foul_tip" }),
      countFlowRow({ ...bases, pitchId: "A" }),
      countFlowRow({
        ...bases,
        pitchId: "I",
        pitchCall: "in_play",
        inPlay: true,
        afterStrikes: 2,
      }),
    ];
    const all = split(rows).find((g) => g.stance === "all");
    expect(all?.pitches).toBe(7);
    expect(counts(all)).toEqual({
      ball: 0,
      strike: 0,
      foul: 0,
      walk: 1,
      strikeout: 1,
      inPlay: 1,
      hitByPitch: 1,
      unresolved: 3,
    });
  });

  it("breaks down verified terminal pitches against the full count and pitch-type samples on request", () => {
    const count = { balls: 2, strikes: 2, stance: "L", pitchType: "직구" };
    const strikeout = { ...count, terminalResult: "strikeout" as const };
    const inPlay = { ...count, pitchCall: "in_play" as const, inPlay: true, afterStrikes: 2 };
    const rows = [
      countFlowRow({ ...strikeout, pitchId: "called", pitchCall: "called_strike" }),
      countFlowRow({ ...strikeout, pitchId: "swing", pitchCall: "swinging_strike" }),
      countFlowRow({
        ...strikeout,
        pitchId: "tip",
        pitchCall: "foul_tip",
        pitchType: "슬라이더",
      }),
      countFlowRow({ ...inPlay, pitchId: "hr", terminalResult: "home_run", stance: "R" }),
      countFlowRow({ ...inPlay, pitchId: "out", terminalResult: "field_out" }),
      countFlowRow({ ...inPlay, pitchId: "unlinked" }),
      countFlowRow({
        ...count,
        pitchId: "ball",
        pitchCall: "ball",
        afterBalls: 3,
        afterStrikes: 2,
      }),
      countFlowRow({ ...count, pitchId: "foul", pitchCall: "foul", afterStrikes: 2 }),
    ];
    const data = analyzePitchCountFlow(
      { ...query, include: "terminal-details" },
      "hp1",
      scope,
      source,
      rows,
    );
    const all = data.groups.find((g) => g.stance === "all");
    expect(all?.terminalDetails).toEqual([
      { outcome: "lookingStrikeout", pitches: 1, rate: 0.125 },
      { outcome: "swingingStrikeout", pitches: 1, rate: 0.125 },
      { outcome: "otherStrikeout", pitches: 1, rate: 0.125 },
      { outcome: "homeRun", pitches: 1, rate: 0.125 },
      { outcome: "battedOut", pitches: 1, rate: 0.125 },
    ]);
    expect(counts(all)).toMatchObject({ strikeout: 3, inPlay: 2, unresolved: 1 });
    const left = data.groups.find((g) => g.stance === "L");
    expect(left?.types.find((type) => type.pitchType === "직구")?.terminalDetails).toEqual([
      { outcome: "lookingStrikeout", pitches: 1, rate: 1 / 6 },
      { outcome: "swingingStrikeout", pitches: 1, rate: 1 / 6 },
      { outcome: "battedOut", pitches: 1, rate: 1 / 6 },
    ]);
    expect(data.groups.find((g) => g.stance === "R")?.terminalDetails).toEqual([
      { outcome: "homeRun", pitches: 1, rate: 1 },
    ]);
    for (const group of split(rows)) {
      expect(group).not.toHaveProperty("terminalDetails");
      expect(group.types.every((type) => !("terminalDetails" in type))).toBe(true);
    }
  });
});
