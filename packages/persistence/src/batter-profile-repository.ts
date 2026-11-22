import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  BatterProfileQuerySchema,
  BatterProfileResponseSchema,
  pitchOutcomeScope,
  type BatterCountFlowQuery,
  type BatterProfileQuery,
} from "@kbo/contracts";
import { analyzeBatterProfile } from "@kbo/game-core";
import { readBatterCountFlow } from "./pitch-count-flow.js";
import type { ResolvePitcherHand } from "./pitcher-hands.js";
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
    private readonly resolveHand?: ResolvePitcherHand,
  ) {}
  public async analyze(input: BatterProfileQuery, batterId: string) {
    const query = Value.Decode(BatterProfileQuerySchema, input);
    const snapshot = await readPitchOutcomes(
      this.pool,
      pitchOutcomeScope(query),
      batterId,
      "batter",
      this.samples,
      query.pitcherHand === undefined ? undefined : this.resolveHand,
    );
    return profile(query, batterId, snapshot);
  }

  public countFlow(input: BatterCountFlowQuery, batterId: string) {
    return readBatterCountFlow(this.pool, input, batterId, this.resolveHand);
  }

  public async compare(
    firstInput: BatterProfileQuery,
    secondInput: BatterProfileQuery,
    batterId: string,
  ) {
    const first = Value.Decode(BatterProfileQuerySchema, firstInput);
    const second = Value.Decode(BatterProfileQuerySchema, secondInput);
    const snapshots = await readPitchOutcomePair(
      this.pool,
      pitchOutcomeScope(first),
      pitchOutcomeScope(second),
      batterId,
      "batter",
      this.samples,
      first.pitcherHand === undefined && second.pitcherHand === undefined
        ? undefined
        : this.resolveHand,
    );
    return {
      first: profile(first, batterId, snapshots.first),
      second: profile(second, batterId, snapshots.second),
    };
  }
}

function profile(query: BatterProfileQuery, batterId: string, snapshot: PitchOutcomeSnapshot) {
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
