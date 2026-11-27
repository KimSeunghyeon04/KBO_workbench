import type { PitchAnalysisComputation, PitchAnalysisRow } from "@kbo/persistence";
import type { ComputationRunner } from "./computation-protocol.js";

/** Adapt the existing bounded executor to persistence's trajectory computation port. */
export function createPitchAnalysisComputation(
  runner: ComputationRunner,
): PitchAnalysisComputation {
  return {
    async calibration(season, sourceHash, rows, previous, signal) {
      const result = await runner.run(
        {
          kind: "pitch_calibration",
          season,
          sourceHash,
          rows,
          previous,
        },
        signal,
      );
      if (result.kind !== "pitch_calibration") throw new Error("Unexpected calibration result");
      return result.value;
    },
    async reference(rows, calibration, releaseBased) {
      const result = await runner.run({
        kind: "pitch_reference",
        rows,
        ...(calibration === null ? {} : { calibration }),
        ...(releaseBased === undefined ? {} : { releaseBased }),
      });
      if (result.kind !== "pitch_reference") throw new Error("Unexpected reference result");
      return result.value;
    },
    async sample(season, pitcherId, sourceHash, rows, reference, calibration, releaseRows) {
      const result = await runner.run({
        kind: "pitch_sample",
        season,
        pitcherId,
        sourceHash,
        rows,
        reference,
        calibration,
        ...(releaseRows === undefined ? {} : { releaseRows }),
      });
      if (result.kind !== "pitch_sample") throw new Error("Unexpected sample result");
      return result.value;
    },
  };
}

export function createPitchReleaseComputation(runner: ComputationRunner) {
  return async (rows: readonly PitchAnalysisRow[]) => {
    const result = await runner.run({ kind: "pitch_release", rows });
    if (result.kind !== "pitch_release") throw new Error("Unexpected pitch release result");
    return result.value;
  };
}
