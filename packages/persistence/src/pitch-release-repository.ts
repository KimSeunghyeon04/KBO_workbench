import { resolveAnalysisScope, type PitchReleaseQuery } from "@kbo/contracts";
import type { Pool } from "pg";
import { analysisSourceHash } from "./analysis-scope.js";
import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { readSeasonPitchReleaseRows } from "./pitch-trajectory-input.js";

export class PitchReleaseRepository {
  public constructor(private readonly pool: Pool) {}

  public async read(query: PitchReleaseQuery, pitcherId: string) {
    const scope = resolveAnalysisScope(query);
    return withAnalysisSnapshot(this.pool, async (client) => {
      const sourceHash = await analysisSourceHash(client, scope);
      const rows = await readSeasonPitchReleaseRows(client, scope, pitcherId);
      return { rows, scope, pitcherId, sourceHash };
    });
  }
}
