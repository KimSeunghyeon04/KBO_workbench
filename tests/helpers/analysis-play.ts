import type { AnalysisPlay, AnalysisState, AnalysisMovement } from "@kbo/contracts";
export function analysisState(overrides: Partial<AnalysisState> = {}): AnalysisState {
  return {
    inning: 1,
    half: "top",
    halfActive: true,
    balls: 0,
    strikes: 0,
    outs: 0,
    awayScore: 0,
    homeScore: 0,
    batterId: "b",
    pitcherId: "p",
    awayPitcherId: "ap",
    homePitcherId: "p",
    paId: "pa",
    bases: [null, null, null],
    ...overrides,
  };
}
export function analysisPlay(overrides: Partial<AnalysisPlay> = {}): AnalysisPlay {
  return {
    gameId: "g",
    revision: 1,
    gameDate: "2024-06-01",
    playId: "play1",
    sequence: 0,
    kind: "plate_result",
    applied: true,
    inning: 1,
    half: "top",
    before: analysisState(),
    after: analysisState(),
    result: "single",
    isBunt: false,
    pitch: null,
    movements: [],
    ...overrides,
  };
}
export function analysisMovement(overrides: Partial<AnalysisMovement> = {}): AnalysisMovement {
  return {
    sequence: 0,
    runnerId: "r",
    pitcherId: "p",
    fromBase: 1,
    toBase: 2,
    outcome: "safe",
    reason: "plate_result",
    derived: false,
    ...overrides,
  };
}
