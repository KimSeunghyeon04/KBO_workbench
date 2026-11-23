import { Type, type Static } from "@sinclair/typebox";
import { OfficialPlayerCareerSchema } from "./official-player-career.js";
import { PlayerBirthYearSchema } from "./official-player-birth-year.js";

const identifier = Type.String({ minLength: 1 });
const optionalId = Type.Union([identifier, Type.Null()]);
const season = Type.Object(
  {
    season: Type.Integer({ minimum: 1982, maximum: 2200 }),
    battingPlayerId: optionalId,
    pitchingPlayerId: optionalId,
  },
  { additionalProperties: false },
);
const entry = Type.Object(
  {
    identity: identifier,
    name: Type.String({ minLength: 1 }),
    primaryPosition: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    teams: Type.Array(Type.String({ minLength: 1 })),
    sourceIds: Type.Array(identifier, { minItems: 1 }),
    seasons: Type.Array(season, { minItems: 1 }),
    career: Type.Optional(OfficialPlayerCareerSchema),
    birthYear: Type.Optional(PlayerBirthYearSchema),
  },
  { additionalProperties: false },
);

export const PlayerDirectorySchema = Type.Array(entry);
export type PlayerDirectoryEntry = Static<typeof entry>;
export type PlayerDirectorySeason = Static<typeof season>;
