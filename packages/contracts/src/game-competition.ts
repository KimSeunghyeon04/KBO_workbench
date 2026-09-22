import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const strict = { additionalProperties: false } as const;
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const GameCompetitionSchema = Type.Union([
  Type.Literal("preseason"),
  Type.Literal("regular"),
  Type.Literal("postseason"),
]);
export const CompetitionPageSchema = Type.Object(
  {
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    competition: GameCompetitionSchema,
    sourceUrl: Type.String({ minLength: 1 }),
    contentHash: hash,
    artifactKey: Type.String({ minLength: 1 }),
    collectedAt: Type.String({ minLength: 1 }),
  },
  strict,
);
export const CompetitionEntrySchema = Type.Object(
  {
    sourceGameId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", maxLength: 100 }),
    gameDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    competition: GameCompetitionSchema,
    pageHash: hash,
  },
  strict,
);
export const GameCompetitionDatasetSchema = Type.Object(
  {
    version: Type.Literal(1),
    season: Type.Integer({ minimum: 1982, maximum: 2200 }),
    pages: Type.Array(CompetitionPageSchema, { minItems: 36, maxItems: 36 }),
    entries: Type.Array(CompetitionEntrySchema),
  },
  strict,
);
export type GameCompetition = Static<typeof GameCompetitionSchema>;
export type CompetitionEntry = Static<typeof CompetitionEntrySchema>;
export type GameCompetitionDataset = Static<typeof GameCompetitionDatasetSchema>;
export const CompetitionGameLinkSchema = Type.Object(
  {
    sourceGameId: CompetitionEntrySchema.properties.sourceGameId,
    matchedSourceGameId: CompetitionEntrySchema.properties.sourceGameId,
    gameDate: CompetitionEntrySchema.properties.gameDate,
  },
  strict,
);
export type CompetitionGameLink = Static<typeof CompetitionGameLinkSchema>;

export function parseGameCompetitionDataset(input: unknown): GameCompetitionDataset {
  const value = Value.Decode(GameCompetitionDatasetSchema, input);
  const keys = new Set(value.pages.map((p) => `${p.month}:${p.competition}`));
  if (keys.size !== 36)
    throw new Error("경기 분류는 12개월·세 경기 종류의 응답이 모두 필요합니다.");
  const ids = new Set<string>();
  for (const row of value.entries) {
    const date = new Date(`${row.gameDate}T00:00:00Z`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== row.gameDate ||
      !row.gameDate.startsWith(`${value.season}-`) ||
      ids.has(row.sourceGameId) ||
      !value.pages.some(
        (p) =>
          p.contentHash === row.pageHash &&
          p.competition === row.competition &&
          p.month === Number(row.gameDate.slice(5, 7)),
      )
    )
      throw new Error(`경기 분류의 날짜·출처·중복이 올바르지 않습니다: ${row.sourceGameId}`);
    ids.add(row.sourceGameId);
  }
  return {
    ...value,
    pages: [...value.pages].sort(
      (a, b) =>
        a.month - b.month ||
        (a.competition < b.competition ? -1 : a.competition > b.competition ? 1 : 0),
    ),
    entries: [...value.entries].sort((a, b) =>
      a.sourceGameId < b.sourceGameId ? -1 : a.sourceGameId > b.sourceGameId ? 1 : 0,
    ),
  };
}
