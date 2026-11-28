import { withAnalysisReadSnapshot, type AnalysisReadSnapshot } from "./analysis-snapshot.js";
import {
  resolveAnalysisScope,
  type AnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import { analysisScopeParameters } from "./analysis-scope.js";
import { setImmediate } from "node:timers/promises";
import {
  DisciplineCatalogSchema,
  DisciplineRowSchema,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_REFERENCE_VERSION,
  type DisciplineCatalog,
  type DisciplineQuery,
  type DisciplineSnapshot,
  type DisciplineRow,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { Pool, PoolClient } from "pg";
import { analysisPitchCatalogSql, scopedTrackedPitchRowsSql } from "./analysis-pitch-input.js";
import type { PitchReferenceWorkspace } from "./pitch-reference-workspace.js";
import { prepareReference, type PitchAnalysisComputation } from "./pitch-analysis-repository.js";

import { decodePitchAnalysisRow, type PitchAnalysisRow } from "./pitch-trajectory-input.js";
import { seasonBatterHeightKeys } from "./season-batter-height-keys.js";

const rowValidator = TypeCompiler.Compile(DisciplineRowSchema);
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
    return withAnalysisReadSnapshot(this.pool, async (snapshot) => {
      const { client, release: releaseSnapshot } = snapshot;
      const { referenceHash, sourceHash } = await this.sourceHashes(snapshot, scope);
      if (sourceHash === knownHash) {
        await releaseSnapshot();
        return { season, sourceHash, reference: null, rows: null };
      }
      let rows: DisciplineRow[] | undefined;
      const reference = await this.references.getOrCreate(
        {
          season,
          sourceHash: referenceHash,
          modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
          referenceVersion: PITCH_REFERENCE_VERSION,
          calibrationHash: null,
        },
        async () => {
          const inputs = await readDisciplineRows(client, scope, true);
          rows = inputs.rows;
          await releaseSnapshot();
          return this.computeReference(inputs.referenceRows, null);
        },
        async () => {
          rows = (await readDisciplineRows(client, scope, false)).rows;
          await releaseSnapshot();
        },
      );
      rows ??= (await readDisciplineRows(client, scope, false)).rows;
      await releaseSnapshot();
      return { season, sourceHash, reference, rows };
    });
  }

  public async readSourceHash(input: DisciplineSourceScope) {
    const scope = disciplineSourceScope(input);
    return withAnalysisReadSnapshot(
      this.pool,
      async (snapshot) => (await this.sourceHashes(snapshot, scope)).sourceHash,
    );
  }

  public async readPeriodSourceHashes(
    first: DisciplineSourceScope,
    second: DisciplineSourceScope,
  ): Promise<readonly [string, string]> {
    const a = disciplineSourceScope(first);
    const b = disciplineSourceScope(second);
    return withAnalysisReadSnapshot(this.pool, async (snapshot) => {
      const { sourceHash: firstHash } = await this.sourceHashes(snapshot, a);
      const secondHash =
        a.season === b.season && a.competition === b.competition
          ? firstHash
          : (await this.sourceHashes(snapshot, b)).sourceHash;
      return [firstHash, secondHash];
    });
  }

  private async sourceHashes(snapshot: AnalysisReadSnapshot, scope: AnalysisScope) {
    const referenceHash = await snapshot.sourceHash(scope);
    const { disciplineHash: sourceHash } = await seasonBatterHeightKeys(
      snapshot.client,
      this.pool,
      scope,
      referenceHash,
    );
    return { referenceHash, sourceHash };
  }
}

async function readDisciplineRows(
  client: PoolClient,
  scope: AnalysisScope,
  includeReference: boolean,
) {
  const result = await client.query<Record<string, unknown>>(
    scopedTrackedPitchRowsSql({
      select: includeReference
        ? 'p.stance,p.pitcher_id AS "pitcherId",p.speed_kph AS "referenceSpeed",r.stadium,(r.game_status=\'final\') AS "gameFinal"'
        : "p.stance",
      pitchPredicate: includeReference
        ? "p.batter_id IS NOT NULL OR p.pitch_type='직구'"
        : "p.batter_id IS NOT NULL",
      ...(includeReference ? { gameColumns: "r.game_id,r.revision,r.stadium,r.game_status" } : {}),
    }),
    analysisScopeParameters(scope),
  );
  const rows: DisciplineRow[] = [];
  const referenceRows: PitchAnalysisRow[] = [];
  let processed = 0;
  for (const { pitcherId, referenceSpeed, stadium, gameFinal, ...row } of result.rows) {
    if (row.batterId !== null) {
      if (!rowValidator.Check(row)) throw new Error("Invalid discipline tracking row");
      rows.push(row);
    }
    if (includeReference && row.pitchType === "직구") {
      const { batterId, season, batterHeightCm, crossPlateX, eligible, inZone, ...geometry } = row;
      void [batterId, season, batterHeightCm, crossPlateX, eligible, inZone];
      referenceRows.push(
        decodePitchAnalysisRow({
          ...geometry,
          pitcherId,
          speedKph: referenceSpeed,
          stadium,
          gameFinal,
        }),
      );
    }
    processed += 1;
    if (processed % 2000 === 0) await setImmediate();
  }
  return { rows, referenceRows };
}

function disciplineSourceScope({ season, competition }: DisciplineSourceScope): AnalysisScope {
  return disciplineSeasonScope(season, competition === undefined ? {} : { competition });
}

function disciplineSeasonScope(season: number, options: AnalysisScopeOptions): AnalysisScope {
  const selectedScope = resolveAnalysisScope({ season, ...options });
  return { ...selectedScope, dateFrom: null, dateTo: null };
}
