import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { canonicalStringify, resolveAnalysisScope, type AnalysisScopeQuery } from "@kbo/contracts";
import { readPitchRows } from "./pitch-analysis-repository.js";
import { analysisSourceHash } from "./analysis-scope.js";
export class PitchAnglesRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(query: AnalysisScopeQuery, pitcherId: string) {
    const scope = resolveAnalysisScope(query, "regular"),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const manifest = await analysisSourceHash(client, scope),
        rows = await readPitchRows(client, scope.season, pitcherId, false, scope, true);
      await client.query("COMMIT");
      return {
        rows,
        scope,
        pitcherId,
        sourceHash: createHash("sha256")
          .update(
            canonicalStringify({
              policy: "raw-trajectory-middle-plane-v1",
              manifest,
              scope,
              pitcherId,
              rows,
            }),
          )
          .digest("hex"),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
