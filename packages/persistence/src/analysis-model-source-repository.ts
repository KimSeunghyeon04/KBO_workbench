import type { Pool } from "pg";
import { readRunManifest, runTrainingHash } from "./run-value-repository.js";
import { parkManifest, parkTrainingHash } from "./park-environment-repository.js";
import { readPitchQualityManifest, pitchQualitySourceHash } from "./pitch-quality-repository.js";

/** Source verification only; no training rows or model fitting on the request path. */
export class AnalysisModelSourceRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(through: number) {
    if (!Number.isInteger(through) || through < 2020 || through > 2024)
      throw new Error("Unsupported model training period");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const run = runTrainingHash(await readRunManifest(client, through));
      const park = parkTrainingHash(await parkManifest(client, through));
      const quality = pitchQualitySourceHash(
        await readPitchQualityManifest(client, through, this.pool),
      );
      await client.query("COMMIT");
      return { re24: run, count: run, win: run, park, quality, matchup: quality };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
