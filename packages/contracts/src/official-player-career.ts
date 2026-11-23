import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isCalendarDate } from "./calendar-date.js";

const season = Type.Integer({ minimum: 1982, maximum: 2200 });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const label = Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" });
const playerId = Type.String({ pattern: "^\\d{5}$" });
const evidence = Type.Object(
  {
    url: Type.String({ pattern: "^https://[^\\s]+$" }),
    artifactKey: Type.String({
      pattern: "^registry/player-careers/source/[a-zA-Z0-9_/-]+\\.(?:html|json)\\.gz$",
    }),
    contentHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);
const club = Type.Object(
  {
    name: label,
    joinedOn: Type.Union([date, Type.Null()]),
  },
  { additionalProperties: false },
);

export const OfficialPlayerCareerSchema = Type.Object(
  {
    firstSeason: season,
    lastSeason: season,
    clubs: Type.Array(club, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type OfficialPlayerCareer = Static<typeof OfficialPlayerCareerSchema>;

const record = Type.Object(
  {
    playerId,
    name: label,
    career: OfficialPlayerCareerSchema,
    sources: Type.Array(evidence, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type OfficialPlayerCareerRecord = Static<typeof record>;

const dataset = Type.Object(
  {
    version: Type.Literal(1),
    records: Type.Array(record),
  },
  { additionalProperties: false },
);

export function parseOfficialPlayerCareerDataset(input: unknown) {
  const decoded = Value.Decode(dataset, input);
  const ids = new Set<string>();
  for (const { playerId: id, career, sources } of decoded.records) {
    const profile = sources[0];
    const url = profile && new URL(profile.url);
    if (
      ids.has(id) ||
      career.firstSeason > career.lastSeason ||
      career.clubs[0]?.joinedOn !== null ||
      sources.length !== career.clubs.length ||
      url?.hostname !== "www.koreabaseball.com" ||
      !/^\/Record\/Player\/(?:Pitcher|Hitter)Detail\/Basic\.aspx$/.test(url.pathname) ||
      url.searchParams.get("playerId") !== id
    )
      throw new Error("공식 선수 경력의 선수·시즌·출처가 일치하지 않습니다.");
    ids.add(id);
    let previousDate = `${career.firstSeason - 1}-12-31`;
    for (const entry of career.clubs.slice(1)) {
      if (
        entry.joinedOn === null ||
        !isCalendarDate(entry.joinedOn) ||
        entry.joinedOn <= previousDate ||
        entry.joinedOn > `${career.lastSeason}-12-31`
      )
        throw new Error("공식 선수 경력의 구단 이동 날짜가 올바르지 않습니다.");
      previousDate = entry.joinedOn;
    }
  }
  return decoded;
}
