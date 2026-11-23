import { expect, it } from "vitest";
import { hasKboPlayerSearchMatch, parseKboPlayerBirthYear } from "@kbo/collection";

const profile = `<div class="player_basic">
  <img id="example_playerProfile_imgProgile" src="/person/middle/2026/12345.jpg">
  <span id="example_playerProfile_lblName">개명 선수</span>
  <span id="example_playerProfile_lblBirthday">2000년 2월 29일</span>
</div>`;

it("reads the public birth year without requiring a career or exposing the full date", () => {
  expect(parseKboPlayerBirthYear(profile, "12345")).toEqual({ name: "개명 선수", birthYear: 2000 });
  expect(parseKboPlayerBirthYear(profile, "54321")).toBeNull();
  expect(parseKboPlayerBirthYear(profile.replace("2000년", "2001년"), "12345")).toBeNull();
});

it("requires the official old-name search to link the exact ID and current name", () => {
  const result = `<table><tbody><tr><td>
    <a href="/Record/Player/PitcherDetail/Basic.aspx?playerId=12345">개명 선수</a>
  </td></tr></tbody></table>`;
  expect(hasKboPlayerSearchMatch(result, "12345", "개명 선수")).toBe(true);
  expect(
    hasKboPlayerSearchMatch(
      result.replace("/Record/Player/PitcherDetail/Basic.aspx", "/Record/Retire/Pitcher.aspx"),
      "12345",
      "개명 선수",
    ),
  ).toBe(true);
  expect(hasKboPlayerSearchMatch(result, "54321", "개명 선수")).toBe(false);
  expect(hasKboPlayerSearchMatch(result, "12345", "다른 선수")).toBe(false);
  expect(
    hasKboPlayerSearchMatch(
      result.replace('href="/Record', 'href="https://example.invalid/Record'),
      "12345",
      "개명 선수",
    ),
  ).toBe(false);
});
