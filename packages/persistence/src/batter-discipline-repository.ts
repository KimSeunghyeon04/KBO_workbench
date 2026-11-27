import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import {
  resolveAnalysisScope,
  type AnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import {
  scopedAnalysisGamesSql,
  analysisScopeParameters,
  analysisSourceHash,
} from "./analysis-scope.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  canonicalStringify,
  DisciplineCatalogSchema,
  DisciplineRowSchema,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_REFERENCE_VERSION,
  type DisciplineCatalog,
  type DisciplineQuery,
  type DisciplineSnapshot,
  type DisciplineRow,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool, PoolClient } from "pg";
import { analysisPitchCatalogSql, scopedTrackedPitchRowsSql } from "./analysis-pitch-input.js";
import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import {
  prepareReference,
  readPitchRows,
  type PitchAnalysisComputation,
} from "./pitch-analysis-repository.js";

const rowValidator = TypeCompiler.Compile(DisciplineRowSchema);
const heightInputSchema = Type.Object(
  {
    gameId: Type.String(),
    revision: Type.Integer(),
    playerId: Type.Union([Type.String(), Type.Null()]),
    heightCm: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
type DisciplineSourceScope = Pick<DisciplineQuery, "season" | "competition">;

export class BatterDisciplineRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly references: Pick<PitchReferenceWorkspace, "getOrCreate">,
    private readonly computeReference: PitchAnalysisComputation["reference"] = async (rows) =>
      prepareReference(rows),
  ) {}

  public async catalog(
    season: number,
    options: AnalysisScopeOptions = {},
  ): Promise<DisciplineCatalog> {
    const scope = resolveAnalysisScope({ season, ...options });
    const result = await this.pool.query<Record<string, unknown>>(
      analysisPitchCatalogSql("batter"),
      analysisScopeParameters(scope),
    );
    return Value.Decode(DisciplineCatalogSchema, { season, scope, batters: result.rows });
  }

  public async snapshot(
    season: number,
    knownHash?: string,
    options: AnalysisScopeOptions = {},
  ): Promise<DisciplineSnapshot> {
    const scope = disciplineSeasonScope(season, options);
    return withAnalysisSnapshot(this.pool, async (client, releaseSnapshot) => {
      const { referenceHash, sourceHash } = await disciplineSourceHashes(client, scope);
      if (sourceHash === knownHash) {
        await releaseSnapshot();
        return { season, sourceHash, reference: null, rows: null };
      }
      const result = await client.query<Record<string, unknown>>(
        scopedTrackedPitchRowsSql({
          select: "p.stance",
          pitchPredicate: "p.batter_id IS NOT NULL",
        }),
        analysisScopeParameters(scope),
      );
      const rows: DisciplineRow[] = [];
      for (const row of result.rows) {
        if (!rowValidator.Check(row)) throw new Error("Invalid discipline tracking row");
        rows.push(row);
        if (rows.length % 2000 === 0) await setImmediate();
      }
      const reference = await this.references.getOrCreate(
        {
          season,
          sourceHash: referenceHash,
          modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
          referenceVersion: PITCH_REFERENCE_VERSION,
          calibrationHash: null,
        },
        async () => {
          const referenceRows = await readPitchRows(client, season, null, false, scope);
          await releaseSnapshot();
          return this.computeReference(referenceRows, null);
        },
      );
      await releaseSnapshot();
      return { season, sourceHash, reference, rows };
    });
  }

  public async readSourceHash(input: DisciplineSourceScope) {
    const scope = disciplineSourceScope(input);
    return withAnalysisSnapshot(
      this.pool,
      async (client) => (await disciplineSourceHashes(client, scope)).sourceHash,
    );
  }

  public async readPeriodSourceHashes(
    first: DisciplineSourceScope,
    second: DisciplineSourceScope,
  ): Promise<readonly [string, string]> {
    const a = disciplineSourceScope(first);
    const b = disciplineSourceScope(second);
    return withAnalysisSnapshot(this.pool, async (client) => {
      const { sourceHash: firstHash } = await disciplineSourceHashes(client, a);
      const secondHash =
        a.season === b.season && a.competition === b.competition
          ? firstHash
          : (await disciplineSourceHashes(client, b)).sourceHash;
      return [firstHash, secondHash];
    });
  }
}

function disciplineSourceScope({ season, competition }: DisciplineSourceScope): AnalysisScope {
  return disciplineSeasonScope(season, competition === undefined ? {} : { competition });
}

function disciplineSeasonScope(season: number, options: AnalysisScopeOptions): AnalysisScope {
  const selectedScope = resolveAnalysisScope({ season, ...options });
  return { ...selectedScope, dateFrom: null, dateTo: null };
}

async function disciplineSourceHashes(client: PoolClient, scope: AnalysisScope) {
  const referenceHash = await analysisSourceHash(client, scope);
  // Supplement imports can change effective heights without changing a sealed game hash.
  const heights = await client.query<Record<string, unknown>>(
    `
    WITH selected_games AS MATERIALIZED (${scopedAnalysisGamesSql()})
    SELECT r.game_id AS "gameId",r.revision,h.player_id AS "playerId",h.height_cm AS "heightCm"
    FROM selected_games r LEFT JOIN LATERAL (
      SELECT h.player_id,h.height_cm FROM analytics.game_batter_heights h
      WHERE h.game_id=r.game_id AND h.revision=r.revision OFFSET 0
    ) h ON TRUE
    ORDER BY r.game_id COLLATE "C",h.player_id COLLATE "C"`,
    analysisScopeParameters(scope),
  );
  const sourceHash = createHash("sha256")
    .update(
      canonicalStringify({
        referenceHash,
        referenceVersion: PITCH_REFERENCE_VERSION,
        zonePolicy: "frozen-player-height-effective-season-v4",
        heights: Value.Decode(Type.Array(heightInputSchema), heights.rows),
      }),
    )
    .digest("hex");
  return { referenceHash, sourceHash };
}
