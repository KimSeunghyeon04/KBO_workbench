import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const strict = { additionalProperties: false } as const;
export const PlayerBattingProfileObservationSchema = Type.Object(
  {
    playerId: Type.String({ minLength: 1, maxLength: 200 }),
    battingSide: Type.Union([Type.Literal("L"), Type.Literal("R"), Type.Literal("S"), Type.Null()]),
    rawValue: Type.String(),
    endpoint: Type.String({ minLength: 1, maxLength: 100 }),
    sourcePath: Type.String({ minLength: 1, maxLength: 500 }),
  },
  strict,
);
export const GamePlayerBattingProfileDatasetSchema = Type.Object(
  {
    gameId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 100 }),
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    sourceBundleHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    observations: Type.Array(PlayerBattingProfileObservationSchema),
  },
  strict,
);
export type PlayerBattingProfileObservation = Static<typeof PlayerBattingProfileObservationSchema>;
export type GamePlayerBattingProfileDataset = Static<typeof GamePlayerBattingProfileDatasetSchema>;
export function parseGamePlayerBattingProfileDataset(
  input: unknown,
): GamePlayerBattingProfileDataset {
  return Value.Decode(GamePlayerBattingProfileDatasetSchema, input);
}
