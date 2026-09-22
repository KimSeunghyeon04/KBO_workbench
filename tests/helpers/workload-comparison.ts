import type { WorkloadAppearance, WorkloadComparisonCell } from "@kbo/contracts";
export function workloadAppearance(
  gameId: string,
  gameDate: string,
  role: WorkloadAppearance["role"] = "starter",
): WorkloadAppearance {
  return {
    gameId,
    revision: 1,
    gameDate,
    teamId: "team",
    teamName: "Team",
    side: "home",
    role,
    pitches: 50,
    battersFaced: 12,
    outs: 9,
  };
}
export function workloadCell(
  gameId: string,
  overrides: Partial<WorkloadComparisonCell> = {},
): WorkloadComparisonCell {
  return {
    gameId,
    revision: 1,
    observedRole: "first_pitcher",
    pitchBucket: 0,
    meeting: 1,
    pitchType: "fast",
    stance: "R",
    balls: 0,
    strikes: 0,
    pitches: 20,
    speedCount: 20,
    speedSum: 2800,
    swings: 10,
    whiffs: 2,
    ...overrides,
  };
}
export function workloadComparisonFixture() {
  const history = Array.from({ length: 6 }, (_, i) =>
    workloadAppearance(`g${i}`, `2024-06-${String(1 + i * 5).padStart(2, "0")}`),
  );
  const cells = history.flatMap((a) => [
    workloadCell(a.gameId),
    workloadCell(a.gameId, {
      pitchType: "slow",
      pitches: 5,
      speedCount: 5,
      speedSum: 600,
      swings: 5,
      whiffs: 1,
    }),
    workloadCell(a.gameId, {
      pitchBucket: 1,
      meeting: 2,
      pitches: 5,
      speedCount: 5,
      speedSum: 700,
      swings: 5,
      whiffs: 1,
    }),
    workloadCell(a.gameId, { pitchBucket: 1, meeting: 2, pitchType: "slow", speedSum: 2400 }),
  ]);
  return { history, cells };
}
