import { describe, expect, it } from "vitest";

import { buildKboLiveTextUrl, kboLiveTextLink } from "../../apps/web/src/correction/kbo-live.js";

describe("KBO 문자중계 URL", () => {
  const expected =
    "https://www.koreabaseball.com/Game/LiveText.aspx?leagueId=1&seriesId=0&gameId=20240809WOHH0&gyear=2024";

  it("공식 ID와 Naver 원천 연도가 붙은 ID를 같은 주소로 정규화한다", () => {
    expect(buildKboLiveTextUrl(" 20240809wohh0 ")).toBe(expected);
    expect(buildKboLiveTextUrl("20240809WOHH02024")).toBe(expected);
  });

  it.each([
    ["20240230WOHH0", "경기일이 유효하지"],
    ["19810101WOHH0", "1982년 이후"],
    ["20240809WOHH02023", "원천 연도가 경기일 연도와 다릅니다"],
    ["not-a-game", "경기 ID는 경기일 8자리"],
  ])("잘못된 ID %s를 거부한다", (gameId, message) => {
    expect(() => buildKboLiveTextUrl(gameId)).toThrow(message);
    expect(kboLiveTextLink(gameId)).toMatchObject({
      url: null,
      error: expect.stringContaining(message),
    });
  });
});
