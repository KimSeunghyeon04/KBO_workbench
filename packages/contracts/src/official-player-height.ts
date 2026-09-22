import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Reviewed, season-scoped evidence. Import never fetches or refreshes these URLs. */
export const OfficialPlayerHeightSchema = Type.Object(
  {
    season: Type.Integer({ minimum: 1982, maximum: 9999 }),
    playerId: Type.String({ minLength: 1, maxLength: 200 }),
    playerName: Type.String({ minLength: 1, maxLength: 200 }),
    birthDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    heightCm: Type.Integer({ minimum: 100, maximum: 250 }),
    reportedValue: Type.Number({ minimum: 1, maximum: 250 }),
    reportedUnit: Type.Union([Type.Literal("cm"), Type.Literal("inch")]),
    sourceUrl: Type.String({ pattern: "^https://", maxLength: 2000 }),
    sourcePlayerId: Type.String({ minLength: 1, maxLength: 200 }),
    checkedOn: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  },
  { additionalProperties: false },
);
export type OfficialPlayerHeight = Static<typeof OfficialPlayerHeightSchema>;
export function parseOfficialPlayerHeights(input: unknown): OfficialPlayerHeight[] {
  const rows = Value.Decode(Type.Array(OfficialPlayerHeightSchema), input);
  const keys = new Set<string>();
  for (const row of rows) {
    const cm = row.reportedValue * (row.reportedUnit === "inch" ? 2.54 : 1);
    if (Math.round(cm) !== row.heightCm) throw new Error("공식 프로필 키의 cm 환산값이 다릅니다.");
    const key = `${row.season}:${row.playerId}`;
    if (keys.has(key)) throw new Error("공식 프로필에 같은 시즌·선수가 중복됩니다.");
    keys.add(key);
  }
  return rows;
}
