import { describe, expect, it } from "vitest";
import { fitPitchCalibration, type PitchCalibrationCell } from "@kbo/game-core";

const parks = ["a", "b", "c"];
const biases = [
  [5, -3],
  [1, 2],
  [-6, 1],
];
function cells(): PitchCalibrationCell[] {
  const result: PitchCalibrationCell[] = [];
  for (let pitcher = 0; pitcher < 30; pitcher++) {
    for (let game = 0; game < 18; game++) {
      for (let type = 0; type < 2; type++) {
        const park = parks[game % 3];
        const bias = biases[game % 3];
        if (park === undefined || bias === undefined) throw new Error("Invalid synthetic park");
        const index = pitcher * 37 + game * 13 + type * 23;
        const speed = Math.sin(index * 0.38);
        const left = Number(index % 3 === 0);
        const balls = (index % 7) / 2;
        const strikes = (index % 5) / 2;
        result.push({
          gameId: `g${String(game).padStart(2, "0")}`,
          gameDate: `2025-06-${String(game + 1).padStart(2, "0")}`,
          pitcherId: `p${pitcher}`,
          pitchType: `type${type}`,
          parkId: park,
          count: 10 + (index % 40),
          speed: 140 + 10 * speed,
          left,
          balls,
          strikes,
          lateral:
            (bias[0] ?? 0) +
            pitcher * 3 +
            type * 6 +
            1.5 * speed +
            0.8 * speed ** 2 +
            0.9 * left +
            0.2 * balls -
            0.1 * strikes,
          vertical:
            (bias[1] ?? 0) -
            pitcher * 2 -
            type * 4 -
            2 * speed +
            0.3 * speed ** 2 -
            0.6 * left +
            0.4 * balls +
            0.3 * strikes,
        });
      }
    }
  }
  return result;
}

describe("daily park movement calibration", () => {
  it("recovers known park effects after pitcher/type/month and nuisance controls", () => {
    const fitted = fitPitchCalibration(cells(), "2025-06-30", parks, "b");
    expect(fitted.status).toBe("ready");
    expect(fitted.coefficients).toHaveLength(3);
    for (const [i, coefficient] of fitted.coefficients.entries()) {
      expect(coefficient.lateralBias).toBeCloseTo(biases[i]?.[0] ?? 0, 7);
      expect(coefficient.verticalBias).toBeCloseTo(biases[i]?.[1] ?? 0, 7);
    }
    expect(fitted.covariance).toHaveLength(6);
    expect(fitted.covariance.every((row) => row.length === 6 && row.every(Number.isFinite))).toBe(
      true,
    );
  });

  it("excludes the target date, future dates, previous seasons and expired observations", () => {
    const input = cells();
    const expected = fitPitchCalibration(input, "2025-06-30", parks, "b");
    for (const gameDate of ["2025-06-30", "2025-07-01", "2024-06-12", "2025-04-06"]) {
      const contaminants = input.map((row) => ({
        ...row,
        gameDate,
        lateral: 50000,
        vertical: -70000,
      }));
      expect(fitPitchCalibration([...input, ...contaminants], "2025-06-30", parks, "b")).toEqual(
        expected,
      );
    }
    expect(expected.lastTrainingDate).toBe("2025-06-18");
    expect(expected.windowStart).toBe("2025-04-07");
  });

  it("is deterministic under input order and keeps a fixed zero point", () => {
    const input = cells();
    const expected = fitPitchCalibration(input, "2025-06-30", parks, "b");
    expect(
      fitPitchCalibration([...input].reverse(), "2025-06-30", [...parks].reverse(), "b"),
    ).toEqual(expected);
    const shifted = fitPitchCalibration(
      input.map((c) => ({ ...c, lateral: c.lateral + 120 })),
      "2025-06-30",
      parks,
      "b",
    );
    for (const [i, c] of shifted.coefficients.entries()) {
      expect(c.lateralBias).toBeCloseTo(expected.coefficients[i]?.lateralBias ?? 0, 8);
    }
    expect(expected.coefficients.reduce((sum, c) => sum + c.lateralBias, 0)).toBeCloseTo(0, 9);
  });

  it("does not fill unsupported or disconnected parks with invented zero coefficients", () => {
    const input = cells();
    expect(
      fitPitchCalibration(
        input.filter((c) => c.parkId !== "c"),
        "2025-06-30",
        parks,
        "b",
      ),
    ).toMatchObject({
      status: "insufficient_data",
      coefficients: [],
      covariance: [],
    });
    const disconnected = input.map((c) => ({ ...c, pitcherId: `${c.pitcherId}-${c.parkId}` }));
    expect(fitPitchCalibration(disconnected, "2025-06-30", parks, "b").status).toBe(
      "insufficient_data",
    );
    expect(
      fitPitchCalibration(
        input.filter((c) => Number(c.pitcherId.slice(1)) < 19),
        "2025-06-30",
        parks,
        "b",
      ).status,
    ).toBe("insufficient_data");
  });

  it("declines park contrasts confounded with the nuisance regressors", () => {
    const input = cells().map((c) => ({ ...c, speed: 130 + parks.indexOf(c.parkId) * 10 }));
    expect(fitPitchCalibration(input, "2025-06-30", parks, "b").status).toBe("unidentifiable");
  });
});
