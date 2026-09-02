import { describe, expect, it } from "vitest";

import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { loadedBasesWithTwoOuts, makeDocument, safe, scored } from "../helpers/game-document.js";

describe("원자적 주자 위치 해석", () => {
  it("후행 주자가 먼저 들어오고 선행 주자가 나중에 비워도 최종 위치로 commit한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a6",
            pitcherId: "hp1",
            creditedRbi: 1,
            movements: [
              safe("a6", 0, 1, 0),
              safe("a3", 1, 2, 1),
              safe("a2", 2, 3, 2),
              scored("a1", 3, 3),
            ],
          },
        },
      ]),
    );

    expect(replay.findings).toEqual([]);
    expect(replay.finalState.awayScore).toBe(1);
    expect(replay.finalState.bases.map((base) => base?.runnerId ?? null)).toEqual([
      "a6",
      "a3",
      "a2",
    ]);
  });

  it("최종 시점에도 점유 충돌이 남으면 play 전체를 rollback한다", () => {
    const specs = loadedBasesWithTwoOuts();
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...specs,
        {
          kind: "plate_appearance_result",
          payload: {
            result: "single",
            batterId: "a6",
            pitcherId: "hp1",
            creditedRbi: 0,
            movements: [safe("a6", 0, 1, 0), safe("a3", 1, 2, 1)],
          },
        },
      ]),
    );

    expect(replay.frames.at(-1)?.applied).toBe(false);
    expect(replay.frames.at(-1)?.after).toEqual(replay.frames.at(-1)?.before);
    expect(replay.findings.map((finding) => finding.code)).toContain("runner_destination_occupied");
  });

  it("연속된 동일 사유의 독립 주자 행을 임시 베이스에서 한 play로 적용한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "triple", batterId: "a1", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "double", batterId: "a2", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
        {
          kind: "runner_play",
          payload: {
            reason: "wild_pitch",
            movements: [safe("a2", 2, 3, 0), scored("a1", 3, 1)],
          },
        },
      ]),
    );

    const runnerPlay = replay.plays.find((play) => play.kind === "runner_advance");
    expect(runnerPlay).toMatchObject({ applied: true, relayEventIds: ["e6", "e7"] });
    expect(runnerPlay?.movements.map((movement) => movement.runnerId)).toEqual(["a1", "a2"]);
    expect(replay.finalState.awayScore).toBe(1);
    expect(replay.finalState.bases.map((base) => base?.runnerId ?? null)).toEqual([
      null,
      null,
      "a2",
    ]);
    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "runner_destination_occupied",
    );
  });

  it("이중도루의 성공 주자와 아웃 주자를 하나의 원자적 play로 묶는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "double", batterId: "a1", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "plate_result",
          payload: { result: "single", batterId: "a2", pitcherId: "hp1" },
        },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a2",
            fromBase: 1,
            toBase: 2,
            outcome: "safe",
            context: { kind: "independent", reason: "stolen_base" },
          },
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 2,
            toBase: 3,
            outcome: "out",
            outKind: "tag",
            context: { kind: "independent", reason: "caught_stealing" },
          },
        },
      ]),
    );

    const runnerPlay = replay.plays.find((play) => play.kind === "runner_advance");
    expect(runnerPlay).toMatchObject({ applied: true, relayEventIds: ["e6", "e7"] });
    expect(replay.finalState.outs).toBe(1);
    expect(replay.finalState.bases.map((base) => base?.runnerId ?? null)).toEqual([
      null,
      "a2",
      null,
    ]);
  });

  it("투구 사이의 연속 주자 행은 사유가 달라도 한 play로 원자 적용한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "double", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "single", batterId: "a2", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a2",
            fromBase: 1,
            toBase: 2,
            outcome: "safe",
            context: { kind: "independent", reason: "error" },
          },
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 2,
            toBase: 3,
            outcome: "safe",
            context: { kind: "independent", reason: "pickoff" },
          },
        },
      ]),
    );

    const runnerPlay = replay.plays.find((play) => play.kind === "runner_advance");
    expect(runnerPlay).toMatchObject({ applied: true, relayEventIds: ["e6", "e7"] });
    expect(replay.finalState.bases.map((base) => base?.runnerId ?? null)).toEqual([
      null,
      "a2",
      "a1",
    ]);
    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "runner_destination_occupied",
    );
  });

  it("review와 administrative가 사이에 있어도 독립 주자 이동을 한 play로 묶는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "double", batterId: "a1", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        { kind: "plate_result", payload: { result: "single", batterId: "a2", pitcherId: "hp1" } },
        { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a2",
            fromBase: 1,
            toBase: 2,
            outcome: "safe",
            context: { kind: "independent", reason: "stolen_base" },
          },
        },
        {
          kind: "review",
          payload: { decision: "upheld", reviewedEventId: "e6" },
          relayText: "비식별 판독 유지",
        },
        {
          kind: "administrative",
          payload: { code: "announcement" },
          relayText: "비식별 안내",
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 2,
            toBase: 3,
            outcome: "safe",
            context: { kind: "independent", reason: "other" },
          },
        },
      ]),
    );

    const runnerPlay = replay.plays.find((play) => play.kind === "runner_advance");
    expect(runnerPlay).toMatchObject({
      applied: true,
      relayEventIds: ["e6", "e7", "e8", "e9"],
    });
    expect(replay.findings.map((finding) => finding.code)).not.toContain(
      "runner_destination_occupied",
    );
  });

  it("행 순서상 제3아웃 뒤에 있는 명시적 득점도 tag out이면 인정한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a1",
            fromBase: 3,
            toBase: 4,
            outcome: "out",
            outKind: "tag",
            context: { kind: "independent", reason: "other" },
          },
        },
        {
          kind: "runner_advance",
          payload: {
            runnerId: "a2",
            fromBase: 2,
            toBase: 4,
            outcome: "scored",
            context: { kind: "independent", reason: "other" },
          },
        },
      ]),
    );

    expect(replay.finalState.outs).toBe(3);
    expect(replay.finalState.awayScore).toBe(1);
  });
});
