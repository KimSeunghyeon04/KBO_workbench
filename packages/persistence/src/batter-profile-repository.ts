import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  BatterProfileResponseSchema,
  type PitchOutcomeQuery,
} from "@kbo/contracts";
import { analyzeBatterProfile } from "@kbo/game-core";
import { readPitchOutcomes } from "./pitch-outcomes.js";
export class BatterProfileRepository {
  public constructor(private readonly pool: Pool) {}
  public async analyze(input: PitchOutcomeQuery, batterId: string) {
    const query = Value.Decode(PitchOutcomeQuerySchema, input);
    const { season, balls, strikes, pitchType, stance, cohort, ...scope } = query;
    void balls;
    void strikes;
    void pitchType;
    void stance;
    void cohort;
    const snapshot = await readPitchOutcomes(this.pool, season, scope, batterId, "batter");
    return Value.Decode(
      BatterProfileResponseSchema,
      analyzeBatterProfile(
        query,
        batterId,
        snapshot.scope,
        snapshot.sourceHash,
        snapshot.rows,
        snapshot.plateAppearances,
      ),
    );
  }
}
