import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";
import { BattingStatisticsQuerySchema, PitchingStatisticsQuerySchema } from "@kbo/contracts";

it.each([BattingStatisticsQuerySchema, PitchingStatisticsQuerySchema])(
  "accepts an optional bounded player ID while retaining the strict statistics query",
  (schema) => {
    expect(Value.Check(schema, { season: 2025 })).toBe(true);
    expect(Value.Check(schema, { season: 2025, playerId: "player-1" })).toBe(true);
    expect(Value.Check(schema, { season: 2025, playerId: "a".repeat(200) })).toBe(true);
    for (const playerId of ["", "a".repeat(201), 1, null])
      expect(Value.Check(schema, { season: 2025, playerId })).toBe(false);
    expect(Value.Check(schema, { season: 2025, playerId: "player-1", unknown: true })).toBe(false);
  },
);
