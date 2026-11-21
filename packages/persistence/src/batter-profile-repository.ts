import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  BatterProfileResponseSchema,
  pitchOutcomeScope,
  type PitchOutcomeQuery,
} from "@kbo/contracts";
import { analyzeBatterProfile } from "@kbo/game-core";
import {
  readPitchOutcomePair,
  readPitchOutcomes,
  type PitchOutcomeCache,
  type PitchOutcomeSnapshot,
} from "./pitch-outcomes.js";
export class BatterProfileRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly samples?: PitchOutcomeCache,
  ) {}
  public async analyze(input: PitchOutcomeQuery, batterId: string) {
    const query = Value.Decode(PitchOutcomeQuerySchema, input);
    const snapshot = await readPitchOutcomes(
      this.pool,
      pitchOutcomeScope(query),
      batterId,
      "batter",
      this.samples,
    );
    return profile(query, batterId, snapshot);
  }

  public async compare(
    firstInput: PitchOutcomeQuery,
    secondInput: PitchOutcomeQuery,
    batterId: string,
  ) {
    const first = Value.Decode(PitchOutcomeQuerySchema, firstInput);
    const second = Value.Decode(PitchOutcomeQuerySchema, secondInput);
    const snapshots = await readPitchOutcomePair(
      this.pool,
      pitchOutcomeScope(first),
      pitchOutcomeScope(second),
      batterId,
      "batter",
      this.samples,
    );
    return {
      first: profile(first, batterId, snapshots.first),
      second: profile(second, batterId, snapshots.second),
    };
  }
}

function profile(query: PitchOutcomeQuery, batterId: string, snapshot: PitchOutcomeSnapshot) {
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
