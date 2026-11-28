import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import type { Pool, PoolClient } from "pg";
import type { AnalysisModelKind } from "@kbo/contracts";
import { readRunManifest, runTrainingHash } from "./run-value-repository.js";
import { parkManifest, parkTrainingHash } from "./park-environment-repository.js";
import { readPitchQualityManifest, pitchQualitySourceHash } from "./pitch-quality-repository.js";
import { readRegularModelScopeHashes, type RegularModelScopeHash } from "./analysis-scope.js";

/** Source verification only; no training rows or model fitting on the request path. */
export class AnalysisModelSourceRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(through: number) {
    return this.withScopeHashes(through, async (client, scopeHashes) => {
      const run = await this.readHash(client, through, "re24", scopeHashes);
      const park = await this.readHash(client, through, "park", scopeHashes);
      const quality = await this.readHash(client, through, "quality", scopeHashes);
      return { re24: run, count: run, win: run, park, quality, matchup: quality };
    });
  }

  public async readForKind(through: number, kind: AnalysisModelKind) {
    return this.withScopeHashes(through, (client, scopeHashes) =>
      this.readHash(client, through, kind, scopeHashes),
    );
  }

  private async withScopeHashes<T>(
    through: number,
    read: (client: PoolClient, scopeHashes: RegularModelScopeHash[]) => Promise<T>,
  ) {
    if (!Number.isInteger(through) || through < 2020 || through > 2199)
      throw new Error("Unsupported model training period");
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const result = await read(client, await readRegularModelScopeHashes(client, through));
      await release();
      return result;
    });
  }

  private async readHash(
    client: PoolClient,
    through: number,
    kind: AnalysisModelKind,
    scopeHashes: RegularModelScopeHash[],
  ) {
    if (kind === "park") return parkTrainingHash(await parkManifest(client, through, scopeHashes));
    if (kind === "quality" || kind === "matchup")
      return pitchQualitySourceHash(
        await readPitchQualityManifest(client, through, this.pool, scopeHashes),
      );
    return runTrainingHash(await readRunManifest(client, through, scopeHashes));
  }
}
