import { describe, expect, it } from "vitest";

import { transitionMovements } from "../../packages/game-core/src/compiler/movement-engine.js";

describe("원자적 movement engine", () => {
  it("검증 실패 시 입력 베이스와 주자 객체를 변경하지 않는다", () => {
    const runner = { runnerId: "r1", responsiblePitcherId: "p1" };
    const state = { outs: 1, bases: [runner, null, null] as const };
    const before = structuredClone(state);
    const result = transitionMovements(
      state,
      [
        {
          movementId: "m1",
          sourceEventId: "e1",
          sourceSequence: 1,
          runnerId: "not-r1",
          fromBase: 1,
          toBase: 2,
          outcome: "safe",
          responsiblePitcherId: "p1",
          derived: false,
        },
      ],
      undefined,
    );

    expect(result).toMatchObject({ ok: false, code: "runner_not_at_origin" });
    expect(state).toEqual(before);
    expect(state.bases[0]).toBe(runner);
  });

  it("연쇄 이동은 원래 베이스를 비운 뒤 임시 베이스 결과를 한 번에 반환한다", () => {
    const state = {
      outs: 0,
      bases: [
        { runnerId: "r1", responsiblePitcherId: "p1" },
        { runnerId: "r2", responsiblePitcherId: "p1" },
        null,
      ] as const,
    };
    const result = transitionMovements(
      state,
      [movement("r2", 2, 3, 0), movement("r1", 1, 2, 1), movement("batter", 0, 1, 2)],
      0,
    );

    expect(result).toMatchObject({
      ok: true,
      bases: [{ runnerId: "batter" }, { runnerId: "r1" }, { runnerId: "r2" }],
    });
    expect(state.bases.map((base) => base?.runnerId ?? null)).toEqual(["r1", "r2", null]);
  });
});

function movement(runnerId: string, fromBase: number, toBase: number, sequence: number) {
  return {
    movementId: `m${String(sequence)}`,
    sourceEventId: `e${String(sequence)}`,
    sourceSequence: sequence,
    runnerId,
    fromBase,
    toBase,
    outcome: "safe" as const,
    responsiblePitcherId: "p1",
    derived: fromBase === 0,
  };
}
