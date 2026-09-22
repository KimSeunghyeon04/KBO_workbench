import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  MatchupQuerySchema,
  resolveAnalysisScope,
  type MatchupQuery,
  type MatchupModel,
} from "@kbo/contracts";
import { analysisSourceHash } from "./analysis-scope.js";
import {
  readPitchQualityManifest,
  readPitchQualityRows,
  pitchQualitySourceHash,
} from "./pitch-quality-repository.js";
export class MatchupModelRepository {
  public constructor(private readonly pool: Pool) {}
  public async read(input: MatchupQuery, model: MatchupModel | null, modelHash: string | null) {
    // HTTP query parsers may use a custom prototype; canonical hashes own a plain decoded value.
    const query = { ...Value.Decode(MatchupQuerySchema, input) },
      { pitcherId, batterId, ...scopeQuery } = query,
      scope = resolveAnalysisScope(scopeQuery, "regular"),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const manifest = await analysisSourceHash(client, scope);
      if (
        scope.competition !== "regular" ||
        (model !== null &&
          (model.trainedThrough !== scope.season - 1 ||
            pitchQualitySourceHash(
              await readPitchQualityManifest(client, model.trainedThrough, this.pool),
            ) !== model.sourceHash))
      ) {
        model = null;
        modelHash = null;
      }
      const pitcherRows = await readPitchQualityRows(client, scope, pitcherId),
        batterRows = await readPitchQualityRows(client, scope, batterId, "batter");
      await client.query("COMMIT");
      return {
        query,
        scope,
        pitcherRows,
        batterRows,
        model,
        modelHash,
        sourceHash: pitchQualitySourceHash({
          version: 1,
          manifest,
          query,
          pitcherRows,
          batterRows,
          modelHash,
        }),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
