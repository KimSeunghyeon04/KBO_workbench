import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const strict = { additionalProperties: false } as const;
export const PlayerHeightObservationSchema = Type.Object(
  {
    playerId: Type.String({ minLength: 1, maxLength: 200 }),
    heightCm: Type.Union([Type.Integer({ minimum: 100, maximum: 250 }), Type.Null()]),
    rawHeight: Type.Union([Type.String(), Type.Null()]),
    endpoint: Type.String({ minLength: 1, maxLength: 100 }),
    sourcePath: Type.String({ minLength: 1, maxLength: 500 }),
  },
  strict,
);
export const GamePlayerHeightDatasetSchema = Type.Object(
  {
    gameId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 }),
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    sourceBundleHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    observations: Type.Array(PlayerHeightObservationSchema),
  },
  strict,
);
export type PlayerHeightObservation = Static<typeof PlayerHeightObservationSchema>;
export type GamePlayerHeightDataset = Static<typeof GamePlayerHeightDatasetSchema>;
export function parseGamePlayerHeightDataset(input: unknown): GamePlayerHeightDataset {
  return Value.Decode(GamePlayerHeightDatasetSchema, input);
}
