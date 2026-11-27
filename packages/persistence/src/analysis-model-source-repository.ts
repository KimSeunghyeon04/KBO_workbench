import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import type { Pool } from "pg";
import { readRunManifest, runTrainingHash } from "./run-value-repository.js";
import { parkManifest, parkTrainingHash } from "./park-environment-repository.js";
import { readPitchQualityManifest, pitchQualitySourceHash } from "./pitch-quality-repository.js";
import { readRegularModelScopeHashes } from "./analysis-scope.js";

/** Source verification only; no training rows or model fitting on the request path. */
export class AnalysisModelSourceRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(through: number) {
    if (!Number.isInteger(through) || through < 2020 || through > 2199)
      throw new Error("Unsupported model training period");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const scopeHashes = await readRegularModelScopeHashes(client, through);
      const run = runTrainingHash(await readRunManifest(client, through, scopeHashes));
      const park = parkTrainingHash(await parkManifest(client, through, scopeHashes));
      const quality = pitchQualitySourceHash(
        await readPitchQualityManifest(client, through, this.pool, scopeHashes),
      );
      await release();
      return { re24: run, count: run, win: run, park, quality, matchup: quality };
    });
  }
}
