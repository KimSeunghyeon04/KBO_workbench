import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  PITCH_CALIBRATION_PARAMETERS,
  PitchAnalysisSampleSchema,
  PitchCalibrationSeasonSchema,
} from "@kbo/contracts";
import {
  calculatePitchCalibration,
  calculatePitchAnalysisSample,
  preparePitchAnalysisReference,
  preparePitchCalibrationCells,
  pitchCalibrationParkId,
  StagingWorkspace,
} from "@kbo/persistence";
import { calibrationRows, emptyCalibration } from "../helpers/pitch-calibration.js";
import { pitchFrom50Feet } from "../helpers/pitch-trajectory.js";

describe("daily park calibration integration", () => {
  it("transports a fitted 50-ft park bias to the release tangent before comparing movement", () => {
    const training = calibrationRows();
    const calibration = calculatePitchCalibration(2025, "a".repeat(64), training);
    const template = training.at(-1);
    if (template === undefined) throw new Error("Missing fixture");
    const fitRows = Array.from({ length: 144 }, (_, i) => {
      const sign = (bit: number) => ((i & bit) === 0 ? -1 : 1);
      return {
        ...template,
        gameId: `fit-${Math.floor(i / 48)}`,
        pitchId: `pitch-${i}`,
        trackingId: `tracking-${i}`,
        x0: 1 + sign(1) / 10,
        y0: 55,
        z0: 6 + sign(2) / 10,
        vx0: sign(4) * 2,
        vy0: -100,
        vz0: sign(8) * 2,
        ax: 0,
        ay: 0,
        az: 0,
      };
    });
    const reference = preparePitchAnalysisReference(fitRows, emptyCalibration(2025), true);
    const result = calculatePitchAnalysisSample(
      2025,
      template.pitcherId,
      calibration.sourceHash,
      [{ ...template, ...pitchFrom50Feet }],
      reference,
      calibration,
      fitRows,
    );
    const referenceTime = (55 - 17 / 24) / 100;
    const cm = (referenceTime ** 2 * 30.48) / 2;
    const scale = 124.6 / 125.4;
    expect(result.points[0]).toMatchObject({
      calibrationStatus: "applied",
      calibrationXcm: expect.closeTo(5.2 * scale * cm, 7),
      calibrationZcm: expect.closeTo(-1.6 * scale * cm, 7),
      xCm: expect.closeTo((8 + 40 / 125.4 - 5.2 * scale) * cm, 7),
      zCm: expect.closeTo((-30 - 40 / 125.4 + 1.6 * scale) * cm, 7),
    });
  });
  it("recovers known biases, standardizes the plane and subtracts acceleration before comparison", () => {
    const rows = calibrationRows();
    const original = structuredClone(rows);
    const calibration = calculatePitchCalibration(2025, "a".repeat(64), rows);
    expect(Value.Check(PitchCalibrationSeasonSchema, calibration)).toBe(true);
    const profile = calibration.profiles.at(-1);
    expect(profile?.status).toBe("ready");
    expect(profile?.lastTrainingDate).toBe("2025-05-15");
    const coefficient = profile?.coefficients.find((c) => c.parkId === "changwon");
    expect(coefficient?.lateralBias).toBeCloseTo(5.2, 8);
    expect(coefficient?.verticalBias).toBeCloseTo(-1.6, 8);
    const reference = preparePitchAnalysisReference(rows, calibration);
    if (reference === null) throw new Error("Missing reference");
    expect(reference.trajectory.distance).toBeCloseTo(50 - 17 / 24, 10);
    const row = rows.at(-1);
    if (row === undefined) throw new Error("Missing pitch");
    const selected = [row, { ...row, pitchId: "unknown", stadium: "울산" }];
    const result = calculatePitchAnalysisSample(
      2025,
      row.pitcherId,
      calibration.sourceHash,
      selected,
      reference,
      calibration,
    );
    const raw = calculatePitchAnalysisSample(
      2025,
      row.pitcherId,
      calibration.sourceHash,
      selected,
      reference,
      emptyCalibration(2025),
    );
    expect(Value.Check(PitchAnalysisSampleSchema, result)).toBe(true);
    expect(result.calibration).toMatchObject({ calibratedCount: 1, uncalibratedCount: 1 });
    const corrected = result.points[0],
      uncorrected = raw.points[0];
    if (corrected === undefined || uncorrected === undefined) throw new Error("Missing comparison");
    expect(corrected.calibrationXcm).toBeCloseTo(
      ((5.2 * reference.trajectory.arrivalSeconds ** 2) / 2) * 30.48,
      8,
    );
    expect(corrected.xCm).toBeCloseTo(uncorrected.xCm - (corrected.calibrationXcm ?? 0), 8);
    expect(corrected.zCm).toBeCloseTo(uncorrected.zCm - (corrected.calibrationZcm ?? 0), 8);
    expect(result.points[1]?.calibrationStatus).toBe("unsupported_park");
    expect(result.points[1]?.calibrationXcm).toBeNull();
    expect(rows).toEqual(original);
    expect(preparePitchCalibrationCells([...rows].reverse())).toEqual(
      preparePitchCalibrationCells(rows),
    );
    expect(preparePitchCalibrationCells(rows.map((r) => ({ ...r, crossPlateY: 17 / 24 })))).toEqual(
      preparePitchCalibrationCells(rows),
    );
  });

  it("reuses only unchanged past windows and revises later profiles after a source correction", () => {
    const rows = calibrationRows();
    const initial = calculatePitchCalibration(2025, "a".repeat(64), rows);
    const changed = rows.map((r) =>
      r.gameDate === "2025-05-10" && r.ax !== null ? { ...r, ax: r.ax + 3 } : r,
    );
    const reused = calculatePitchCalibration(2025, "b".repeat(64), changed, initial);
    expect(reused).toEqual(calculatePitchCalibration(2025, "b".repeat(64), changed));
    expect(reused.profiles.filter((p) => p.asOf <= "2025-05-10")).toEqual(
      initial.profiles.filter((p) => p.asOf <= "2025-05-10"),
    );
    expect(reused.profiles.at(-1)?.inputHash).not.toBe(initial.profiles.at(-1)?.inputHash);
    expect(reused.profiles.at(-1)?.coefficients).not.toEqual(initial.profiles.at(-1)?.coefficients);
    expect(initial.profiles[0]?.status).toBe("insufficient_data");
    expect(pitchCalibrationParkId(2024, "대전")).toBe("daejeon-old");
    expect(pitchCalibrationParkId(2025, "대전")).toBe("daejeon-new");
    expect(pitchCalibrationParkId(2025, "대전(신)")).toBe("daejeon-new");
  });

  it("coalesces work, survives restart and passes a validated older snapshot only as a reuse hint", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-calibration-"));
    let workspace = await StagingWorkspace.open(temp.path);
    const key = {
      modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
      season: 2024,
      sourceHash: "a".repeat(64),
    };
    const calculate = vi.fn(async () => emptyCalibration());
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => workspace.pitchCalibrations.getOrCreate(key, calculate)),
      );
      expect(calculate).toHaveBeenCalledTimes(1);
      expect(results[0]).toEqual(emptyCalibration());
      results[0]?.profiles.splice(0);
      await workspace.close();
      workspace = await StagingWorkspace.open(temp.path);
      expect(await workspace.pitchCalibrations.getOrCreate(key, calculate)).toEqual(
        emptyCalibration(),
      );
      expect(calculate).toHaveBeenCalledTimes(1);
      const next = { ...key, sourceHash: "b".repeat(64) };
      const update = vi.fn(async () => ({ ...emptyCalibration(), sourceHash: next.sourceHash }));
      await workspace.pitchCalibrations.getOrCreate(next, update);
      expect(update).toHaveBeenCalledWith(emptyCalibration());
    } finally {
      await workspace.close();
    }
    await expect(
      workspace.pitchCalibrations.getOrCreate({ ...key, sourceHash: "c".repeat(64) }, async () => ({
        ...emptyCalibration(),
        sourceHash: "c".repeat(64),
      })),
    ).rejects.toThrow();
  });

  it.each(["json", "hash", "source", "future"])(
    "rejects %s cache corruption and recalculates",
    async (damage) => {
      await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-calibration-"));
      const workspace = await StagingWorkspace.open(temp.path);
      const key = {
        modelVersion: PITCH_CALIBRATION_PARAMETERS.modelVersion,
        season: 2024,
        sourceHash: "a".repeat(64),
      };
      const calculate = vi.fn(async () => emptyCalibration());
      const file = path.join(
        temp.path,
        `analysis/pitch-calibration/v${key.modelVersion}/2024`,
        `${key.sourceHash}.json`,
      );
      try {
        await workspace.pitchCalibrations.getOrCreate(key, calculate);
        const envelope = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        if (damage === "hash") envelope.hash = "0".repeat(64);
        if (damage === "source")
          envelope.payload = { ...emptyCalibration(), sourceHash: "b".repeat(64) };
        if (damage === "future")
          envelope.payload = {
            ...emptyCalibration(),
            profiles: [
              {
                asOf: "2024-06-01",
                windowStart: "2024-03-09",
                inputHash: "d".repeat(64),
                status: "insufficient_data",
                lastTrainingDate: "2024-06-02",
                trainingCells: 0,
                trainingGames: 0,
                trainingPitchers: 0,
                coefficients: [],
                covariance: [],
              },
            ],
          };
        if (damage === "future" || damage === "source") {
          expect(Value.Check(PitchCalibrationSeasonSchema, envelope.payload)).toBe(true);
          envelope.hash = createHash("sha256")
            .update(canonicalStringify(envelope.payload))
            .digest("hex");
        }
        await writeFile(file, damage === "json" ? "{" : JSON.stringify(envelope));
        expect(await workspace.pitchCalibrations.getOrCreate(key, calculate)).toEqual(
          emptyCalibration(),
        );
        expect(calculate).toHaveBeenCalledTimes(2);
      } finally {
        await workspace.close();
      }
    },
  );
});
