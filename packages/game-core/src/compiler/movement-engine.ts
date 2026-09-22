import { thirdOutCancelsEveryRun } from "../rules.js";
import type { BaseOccupant, CompiledRunnerMovement, FindingDetail } from "../types.js";

export interface MovementState {
  readonly outs: number;
  readonly bases: readonly [BaseOccupant | null, BaseOccupant | null, BaseOccupant | null];
}

export interface MovementFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly FindingDetail[];
}

export interface MovementSuccess {
  readonly ok: true;
  readonly outs: number;
  readonly outsAdded: number;
  readonly bases: readonly [BaseOccupant | null, BaseOccupant | null, BaseOccupant | null];
  readonly scored: readonly CompiledRunnerMovement[];
}

export type MovementTransition = MovementFailure | MovementSuccess;

export function orderPlayMovements(
  state: MovementState,
  movements: readonly CompiledRunnerMovement[],
): readonly CompiledRunnerMovement[] {
  const pending = movements.map((movement, index) => ({ movement, index }));
  const predecessors = pending.map(() => new Set<number>());
  for (const { movement, index } of pending) {
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (movements[earlier]?.runnerId === movement.runnerId) predecessors[index]?.add(earlier);
    }
    if (movement.outcome !== "safe" || movement.toBase >= 4) continue;
    const occupant = state.bases[movement.toBase - 1];
    if (occupant === null || occupant === undefined || occupant.runnerId === movement.runnerId) {
      continue;
    }
    const clearing = pending.find(
      (candidate) =>
        candidate.movement.runnerId === occupant.runnerId &&
        candidate.movement.fromBase === movement.toBase,
    );
    if (clearing !== undefined) predecessors[index]?.add(clearing.index);
  }
  const ordered: CompiledRunnerMovement[] = [];
  const completed = new Set<number>();
  while (ordered.length < movements.length) {
    const available = pending.filter(({ index }) => {
      if (completed.has(index)) return false;
      return [...(predecessors[index] ?? [])].every((candidateIndex) =>
        completed.has(candidateIndex),
      );
    });
    available.sort((left, right) => {
      const leftDeferredOut =
        left.movement.outcome === "out" &&
        movements
          .slice(0, left.index)
          .some((movement) => movement.runnerId === left.movement.runnerId);
      const rightDeferredOut =
        right.movement.outcome === "out" &&
        movements
          .slice(0, right.index)
          .some((movement) => movement.runnerId === right.movement.runnerId);
      return (
        Number(leftDeferredOut) - Number(rightDeferredOut) ||
        right.movement.fromBase - left.movement.fromBase ||
        left.index - right.index
      );
    });
    const selected = available[0];
    if (selected === undefined) return [...movements];
    completed.add(selected.index);
    ordered.push(selected.movement);
  }
  return ordered;
}

/** 모든 이동을 복사한 임시 베이스에서 검증하고 성공 결과만 반환한다. */
export function transitionMovements(
  state: MovementState,
  placementMovements: readonly CompiledRunnerMovement[],
  directOuts: number | undefined,
  chronologicalMovements: readonly CompiledRunnerMovement[] = placementMovements,
): MovementTransition {
  const bases = state.bases.map((base) => (base === null ? null : { ...base })) as [
    BaseOccupant | null,
    BaseOccupant | null,
    BaseOccupant | null,
  ];
  const currentBaseByRunner = new Map<string, number>(
    bases.flatMap((base, index) => (base === null ? [] : [[base.runnerId, index + 1] as const])),
  );
  const origins = new Set<string>();
  for (const movement of placementMovements) {
    if (movement.fromBase === 0) {
      currentBaseByRunner.set(
        movement.runnerId,
        movement.outcome === "safe" && movement.toBase < 4 ? movement.toBase : 0,
      );
      continue;
    }
    const originKey = `${movement.runnerId}:${String(movement.fromBase)}`;
    if (origins.has(originKey)) {
      return failure(
        "movement_origin_duplicated",
        "한 플레이에서 같은 출발 베이스를 두 번 사용했습니다.",
      );
    }
    // 같은 베이스에 살아 돌아온 원천 행은 그 베이스를 떠난 이동이 아니다.
    // 뒤따르는 진루는 허용하되 두 번 실제로 떠나는 중복 이동은 계속 거부한다.
    if (movement.outcome !== "safe" || movement.toBase !== movement.fromBase) {
      origins.add(originKey);
    }
    const occupant = bases[movement.fromBase - 1];
    if (currentBaseByRunner.get(movement.runnerId) !== movement.fromBase) {
      return failure("runner_not_at_origin", "주자가 지정한 출발 베이스에 없습니다.", [
        { field: "runnerId", expected: occupant?.runnerId ?? null, actual: movement.runnerId },
        { field: "fromBase", actual: movement.fromBase },
      ]);
    }
    currentBaseByRunner.set(
      movement.runnerId,
      movement.outcome === "safe" && movement.toBase < 4 ? movement.toBase : 0,
    );
  }
  for (const movement of placementMovements) {
    if (movement.fromBase > 0) bases[movement.fromBase - 1] = null;
  }
  const placementMovementOuts = chronologicalMovements.filter(
    (movement) => movement.outcome === "out",
  ).length;
  const placementBatterOuts = chronologicalMovements.filter(
    (movement) => movement.fromBase === 0 && movement.outcome === "out",
  ).length;
  const placementResultOuts = directOuts ?? placementBatterOuts;
  const placementOutsAdded = placementMovementOuts + placementResultOuts - placementBatterOuts;
  const placementThirdOutIndex =
    state.outs < 3 && state.outs + placementOutsAdded >= 3
      ? indexOfThirdOut(
          chronologicalMovements,
          state.outs,
          placementResultOuts - placementBatterOuts,
        )
      : Number.POSITIVE_INFINITY;
  const finalMovements = placementMovements
    .map((movement, index) => ({ movement, index }))
    .filter(
      ({ movement, index }) =>
        !placementMovements
          .slice(index + 1)
          .some((candidate) => candidate.runnerId === movement.runnerId),
    );
  for (const { movement } of finalMovements) {
    if (movement.outcome !== "safe" || movement.toBase === 4) continue;
    if (Number.isFinite(placementThirdOutIndex)) continue;
    const baseIndex = movement.toBase - 1;
    if (bases[baseIndex] !== null) {
      return failure(
        "runner_destination_occupied",
        "한 플레이의 이동 뒤 같은 베이스를 두 주자가 점유합니다.",
        [{ field: "toBase", actual: movement.toBase }],
      );
    }
    bases[baseIndex] = {
      runnerId: movement.runnerId,
      responsiblePitcherId: movement.responsiblePitcherId,
    };
  }
  const movementOuts = chronologicalMovements.filter(
    (movement) => movement.outcome === "out",
  ).length;
  const batterOuts = chronologicalMovements.filter(
    (movement) => movement.fromBase === 0 && movement.outcome === "out",
  ).length;
  const resultOuts = directOuts ?? batterOuts;
  if (resultOuts < batterOuts) {
    return failure(
      "direct_outs_less_than_batter_out",
      "결과의 직접 아웃 수가 타자 아웃보다 작습니다.",
    );
  }
  const outsAdded = movementOuts + resultOuts - batterOuts;
  const naturalThirdOutIndex = indexOfThirdOut(
    chronologicalMovements,
    state.outs,
    resultOuts - batterOuts,
  );
  const fourthOutIndexes = chronologicalMovements.flatMap((movement, index) =>
    movement.supersedesThirdOut === true ? [index] : [],
  );
  if (fourthOutIndexes.length > 1) {
    return failure(
      "multiple_apparent_fourth_outs",
      "apparent fourth out은 하나만 지정할 수 있습니다.",
    );
  }
  const apparentFourthOutIndex = fourthOutIndexes[0] ?? null;
  if (
    apparentFourthOutIndex !== null &&
    chronologicalMovements[apparentFourthOutIndex]?.outcome !== "out"
  ) {
    return failure("fourth_out_not_out", "apparent fourth out 지정 행은 아웃이어야 합니다.");
  }
  if (
    apparentFourthOutIndex !== null &&
    (naturalThirdOutIndex === Number.POSITIVE_INFINITY ||
      apparentFourthOutIndex <= naturalThirdOutIndex)
  ) {
    return failure(
      "fourth_out_not_after_third_out",
      "대체할 아웃은 원래 제3아웃 뒤에 기록되어야 합니다.",
    );
  }
  if (state.outs + outsAdded > 3 && apparentFourthOutIndex === null) {
    return failure("outs_exceed_three", "한 플레이가 반이닝의 3아웃을 초과합니다.", [
      { field: "outs", expected: 3, actual: state.outs + outsAdded },
    ]);
  }
  const reachesThird = state.outs < 3 && state.outs + outsAdded >= 3;
  const thirdOutIndex = reachesThird
    ? (apparentFourthOutIndex ?? naturalThirdOutIndex)
    : Number.POSITIVE_INFINITY;
  const selectedOut = Number.isFinite(thirdOutIndex)
    ? chronologicalMovements[thirdOutIndex]
    : undefined;
  const cancellingOut =
    selectedOut !== undefined && thirdOutCancelsEveryRun(selectedOut.outKind ?? "tag");
  const startingBaseByRunner = new Map<string, number>();
  for (const movement of chronologicalMovements) {
    if (!startingBaseByRunner.has(movement.runnerId)) {
      startingBaseByRunner.set(movement.runnerId, movement.fromBase);
    }
  }
  const appealedRunnerStartingBase =
    selectedOut?.outKind === "appeal_time"
      ? startingBaseByRunner.get(selectedOut.runnerId)
      : undefined;
  const scored = chronologicalMovements.filter(
    (movement) =>
      movement.outcome === "scored" &&
      (!reachesThird || !cancellingOut) &&
      (appealedRunnerStartingBase === undefined ||
        (startingBaseByRunner.get(movement.runnerId) ?? movement.fromBase) >
          appealedRunnerStartingBase),
  );
  const officialOutsAdded = Math.min(3 - state.outs, outsAdded);
  const outs = state.outs + officialOutsAdded;
  return {
    ok: true,
    outs,
    outsAdded: officialOutsAdded,
    bases: outs === 3 ? [null, null, null] : bases,
    scored,
  };
}

function indexOfThirdOut(
  movements: readonly CompiledRunnerMovement[],
  outsBefore: number,
  anonymousOuts: number,
): number {
  let outs = outsBefore + anonymousOuts;
  for (const [index, movement] of movements.entries()) {
    if (movement.outcome === "out") outs += 1;
    if (outs >= 3) return index;
  }
  return Number.POSITIVE_INFINITY;
}

function failure(
  code: string,
  message: string,
  details?: readonly FindingDetail[],
): MovementFailure {
  return { ok: false, code, message, ...(details === undefined ? {} : { details }) };
}
