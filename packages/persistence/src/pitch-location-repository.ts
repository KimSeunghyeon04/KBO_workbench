import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  PitchLocationResponseSchema,
  PitchLocationComparisonQuerySchema,
  PitchLocationComparisonResponseSchema,
  pitchLocationComparisonQueries,
  pitchOutcomeScope,
  type PitchOutcomeQuery,
  type PitchLocationComparisonQuery,
} from "@kbo/contracts";
import { analyzePitchLocation, comparePitchLocations } from "@kbo/game-core";
import {
  readPitchOutcomePair,
  readPitchOutcomes,
  type PitchOutcomeCache,
  type PitchOutcomeSnapshot,
} from "./pitch-outcomes.js";
export class PitchLocationRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly samples?: PitchOutcomeCache,
  ) {}
  public async compare(input: PitchLocationComparisonQuery, pitcherId: string) {
    const query = Value.Decode(PitchLocationComparisonQuerySchema, input);
    const { first, second } = pitchLocationComparisonQueries(query);
    const snapshots = await readPitchOutcomePair(
      this.pool,
      pitchOutcomeScope(first),
      pitchOutcomeScope(second),
      pitcherId,
      "pitcher",
      this.samples,
    );
    return Value.Decode(
      PitchLocationComparisonResponseSchema,
      comparePitchLocations(
        query,
        pitcherId,
        location(first, pitcherId, snapshots.first),
        location(second, pitcherId, snapshots.second),
      ),
    );
  }
  public async analyze(input: PitchOutcomeQuery, pitcherId: string) {
    const query = Value.Decode(PitchOutcomeQuerySchema, input);
    const snapshot = await readPitchOutcomes(
      this.pool,
      pitchOutcomeScope(query),
      pitcherId,
      "pitcher",
      this.samples,
    );
    return Value.Decode(PitchLocationResponseSchema, location(query, pitcherId, snapshot));
  }
}

function location(query: PitchOutcomeQuery, pitcherId: string, snapshot: PitchOutcomeSnapshot) {
  return analyzePitchLocation(
    query,
    pitcherId,
    snapshot.scope,
    snapshot.sourceHash,
    snapshot.rows,
    snapshot.plateAppearances,
  );
}
