import type { PitchOutcomeRow, TerminalPaRow } from "@kbo/contracts";
import { disciplineRow } from "./batter-discipline.js";
export function outcomeRow(overrides: Partial<PitchOutcomeRow> = {}): PitchOutcomeRow {
  return {
    ...disciplineRow(),
    pitcherId: "hp1",
    pitchSequence: 0,
    paId: "pa1",
    pitchCall: "called_strike",
    calledStrike: true,
    csw: true,
    inPlay: false,
    ...overrides,
  };
}
export function terminalPa(overrides: Partial<TerminalPaRow> = {}): TerminalPaRow {
  return {
    gameId: "test-game",
    revision: 1,
    gameDate: "2024-06-01",
    paId: "pa1",
    batterId: "b1",
    pitcherId: "hp1",
    completed: true,
    countsAsPa: true,
    countsAsAb: true,
    countsAsBf: true,
    result: "strikeout",
    eligible: true,
    pitchId: "p1",
    terminalActual: true,
    terminalBatterId: "b1",
    terminalPitcherId: "hp1",
    pitchType: "직구",
    stance: "R",
    speedKph: 145,
    pitchCall: "called_strike",
    inPlay: false,
    beforeBalls: 0,
    beforeStrikes: 2,
    afterBalls: 0,
    afterStrikes: 3,
    ...overrides,
  };
}
