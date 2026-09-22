import { expect, it } from "vitest";
import { trainPitchQualityFromFacts } from "@kbo/persistence";
import { ComputationPool } from "../../apps/server/src/computation-pool.js";
import { qualityRows } from "../helpers/pitch-quality.js";
it("transfers quality input in bounded chunks and fits without a request-side training path", async () => {
  const pool = new ComputationPool(1, 1),
    rows = qualityRows(),
    hash = "a".repeat(64);
  try {
    const result = await pool.run({
      kind: "pitch_quality_model",
      rows,
      sourceHash: hash,
      through: 2024,
    });
    expect(result).toEqual({
      kind: "pitch_quality_model",
      value: trainPitchQualityFromFacts(rows, hash, 2024),
    });
  } finally {
    await pool.close();
  }
});
