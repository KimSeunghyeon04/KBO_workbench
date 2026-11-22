import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isCalendarDate } from "./calendar-date.js";

const profileSchema = Type.Object(
  {
    gameId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" }),
    sourceBundleHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    pitcherId: Type.String({ pattern: "^[0-9]{1,20}$" }),
    pitcherName: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
    reportedHand: Type.String({ minLength: 1, maxLength: 30, pattern: "\\S" }),
    sourceUrl: Type.String({
      pattern:
        "^https://www\\.koreabaseball\\.com/Record/Player/PitcherDetail/(?:Basic|Total)\\.aspx\\?playerId=[0-9]+$",
    }),
    checkedOn: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  },
  { additionalProperties: false },
);

export function parseOfficialPitcherHandProfile(input: unknown) {
  const profile = Value.Decode(profileSchema, input);
  if (!isCalendarDate(profile.checkedOn))
    throw new Error("공식 프로필 확인 날짜가 올바르지 않습니다.");
  if (new URL(profile.sourceUrl).searchParams.get("playerId") !== profile.pitcherId)
    throw new Error("KBO 공식 프로필의 선수 ID와 대상 투수 ID가 다릅니다.");
  return profile;
}
