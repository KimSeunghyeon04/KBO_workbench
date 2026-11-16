import type { PitchSequenceRow } from "@kbo/contracts";

export function pitchSequenceRow(
  pitchSequence: number,
  overrides: Partial<PitchSequenceRow> = {},
): PitchSequenceRow {
  return {
    gameId: "g",
    revision: 1,
    gameDate: "2024-06-01",
    stadium: "구장 A",
    pitchId: `e${pitchSequence}`,
    pitchSequence,
    paId: "pa",
    pitcherId: "p",
    batterId: "b",
    pitchType: "직구",
    stance: "R",
    speedKph: 140,
    balls: 0,
    strikes: 0,
    actual: true,
    pitchCall: "ball",
    swing: false,
    whiff: false,
    calledStrike: false,
    eligible: true,
    interveningChange: false,
    supported: true,
    trackingId: `t${pitchSequence}`,
    x0: 0,
    y0: 50,
    z0: 6,
    vx0: 1,
    vy0: -140,
    vz0: -4,
    ax: 0,
    ay: 20,
    az: -15,
    crossPlateX: 0,
    crossPlateY: 1.4167,
    ...overrides,
  };
}

export function independentSequenceSamples(): PitchSequenceRow[] {
  return [
    pitchSequenceRow(0),
    pitchSequenceRow(1, { speedKph: 150, crossPlateX: null, swing: true, whiff: true }),
    pitchSequenceRow(2, { paId: "pa2" }),
    pitchSequenceRow(3, { paId: "pa2", speedKph: null, swing: true }),
    pitchSequenceRow(4, { paId: "pa3" }),
    pitchSequenceRow(5, {
      paId: "pa3",
      trackingId: null,
      speedKph: 136,
      calledStrike: true,
    }),
  ];
}
