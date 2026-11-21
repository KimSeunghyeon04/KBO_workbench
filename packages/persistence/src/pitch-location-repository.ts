import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  PitchLocationResponseSchema,
  PitchLocationComparisonQuerySchema,
  PitchLocationComparisonResponseSchema,
  pitchLocationComparisonQueries,
  resolveAnalysisScope,
  type PitchOutcomeQuery,
  type PitchLocationComparisonQuery,
} from "@kbo/contracts";
import { analyzePitchLocation, comparePitchLocations } from "@kbo/game-core";
import {
  readPitchOutcomes,
  readPitchOutcomeRows,
  pitchOutcomeSourceHash,
} from "./pitch-outcomes.js";
import { withAnalysisSnapshot } from "./analysis-snapshot.js";
import { analysisSourceHash } from "./analysis-scope.js";
export class PitchLocationRepository {
  public constructor(private readonly pool: Pool) {}
  public async compare(input: PitchLocationComparisonQuery, pitcherId: string) {
    const query = Value.Decode(PitchLocationComparisonQuerySchema, input);
    const { first, second } = pitchLocationComparisonQueries(query);
    const scopeOf = ({ season, competition, dateFrom, dateTo }: PitchOutcomeQuery) =>
      resolveAnalysisScope(
        {
          season,
          ...(competition === undefined ? {} : { competition }),
          ...(dateFrom === undefined ? {} : { dateFrom }),
          ...(dateTo === undefined ? {} : { dateTo }),
        },
        "regular",
      );
    const firstScope = scopeOf(first),
      secondScope = scopeOf(second);
    return withAnalysisSnapshot(this.pool, async (client, release) => {
      const firstManifest = await analysisSourceHash(client, firstScope);
      const a = await readPitchOutcomeRows(client, firstScope, pitcherId, "pitcher");
      const secondManifest = await analysisSourceHash(client, secondScope);
      const b = await readPitchOutcomeRows(client, secondScope, pitcherId, "pitcher");
      await release();
      return Value.Decode(
        PitchLocationComparisonResponseSchema,
        comparePitchLocations(
          query,
          pitcherId,
          analyzePitchLocation(
            first,
            pitcherId,
            firstScope,
            pitchOutcomeSourceHash(firstManifest, "pitcher", pitcherId, a.rows, a.plateAppearances),
            a.rows,
            a.plateAppearances,
          ),
          analyzePitchLocation(
            second,
            pitcherId,
            secondScope,
            pitchOutcomeSourceHash(
              secondManifest,
              "pitcher",
              pitcherId,
              b.rows,
              b.plateAppearances,
            ),
            b.rows,
            b.plateAppearances,
          ),
        ),
      );
    });
  }
  public async analyze(input: PitchOutcomeQuery, pitcherId: string) {
    const query = Value.Decode(PitchOutcomeQuerySchema, input);
    const { season, balls, strikes, pitchType, stance, cohort, ...scope } = query;
    void balls;
    void strikes;
    void pitchType;
    void stance;
    void cohort;
    const snapshot = await readPitchOutcomes(this.pool, season, scope, pitcherId, "pitcher");
    return Value.Decode(
      PitchLocationResponseSchema,
      analyzePitchLocation(
        query,
        pitcherId,
        snapshot.scope,
        snapshot.sourceHash,
        snapshot.rows,
        snapshot.plateAppearances,
      ),
    );
  }
}
