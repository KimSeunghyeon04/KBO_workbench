import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  PitchLocationResponseSchema,
  type PitchOutcomeQuery,
} from "@kbo/contracts";
import { analyzePitchLocation } from "@kbo/game-core";
import { readPitchOutcomes } from "./pitch-outcomes.js";
export class PitchLocationRepository {
  public constructor(private readonly pool: Pool) {}
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
