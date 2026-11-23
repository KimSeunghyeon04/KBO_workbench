import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const PlayerBirthYearSchema = Type.Integer({ minimum: 1850, maximum: 2200 });

const evidence = Type.Object(
  {
    url: Type.String({ pattern: "^https://www\\.koreabaseball\\.com/[^\\s]+$" }),
    artifactKey: Type.String({
      pattern: "^registry/player-careers/source/[a-zA-Z0-9_/-]+\\.html\\.gz$",
    }),
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

const record = Type.Object(
  {
    playerId: Type.String({ pattern: "^\\d{5}$" }),
    name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
    officialName: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
    birthYear: PlayerBirthYearSchema,
    profile: evidence,
    alias: Type.Optional(evidence),
  },
  { additionalProperties: false },
);
export type OfficialPlayerBirthYear = Static<typeof record>;

const dataset = Type.Object(
  {
    version: Type.Literal(1),
    records: Type.Array(record),
  },
  { additionalProperties: false },
);

export function parseOfficialPlayerBirthYears(input: unknown) {
  const result = Value.Decode(dataset, input);
  const seen = new Set<string>();
  for (const { playerId, name, officialName, profile, alias } of result.records) {
    const url = new URL(profile.url);
    const aliasUrl = alias && new URL(alias.url);
    const key = `${playerId}\u0000${name}`;
    if (
      seen.has(key) ||
      url.searchParams.get("playerId") !== playerId ||
      !/^\/Record\/Player\/(?:Pitcher|Hitter)Detail\/Basic\.aspx$/.test(url.pathname) ||
      (name === officialName
        ? alias !== undefined
        : aliasUrl?.pathname !== "/Player/Search.aspx" ||
          aliasUrl.searchParams.get("searchWord") !== name)
    )
      throw new Error("공식 출생연도 자료의 선수와 출처가 일치하지 않습니다.");
    seen.add(key);
  }
  return result;
}
