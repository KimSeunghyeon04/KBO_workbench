import { expect, it } from "vitest";
import {
  careerCoversObservedClubs,
  parseCareerMovement,
  parseKboPlayerCareerProfile,
} from "@kbo/collection";

function profile({ history = "가상초-가상중-가상고-LG", games = "2", id = "12345" } = {}) {
  return `<h4 id="h4Team">삼성 라이온즈</h4>
    <div class="player_basic">
      <img id="example_playerProfile_imgProgile" src="/person/middle/2026/${id}.jpg">
      <span id="example_playerProfile_lblName">가상 선수</span>
      <span id="example_playerProfile_lblPosition">투수(우투우타)</span>
      <span id="example_playerProfile_lblJoinInfo">10LG</span>
      <span id="example_playerProfile_lblCareer">${history}</span>
    </div>
    <section class="player_records">
      <h6>2026 성적</h6>
      <div class="tbl-type02"><table><thead><tr><th>팀명</th><th>ERA</th><th>G</th></tr></thead>
      <tbody><tr><td>삼성</td><td>3.30</td><td>${games}</td></tr></tbody></table></div>
    </section>`;
}

it("anchors the career to the exact player's entry club and last confirmed playing season", () => {
  expect(parseKboPlayerCareerProfile(profile(), "12345")).toEqual({
    playerId: "12345",
    name: "가상 선수",
    position: "투수",
    firstSeason: 2010,
    lastSeason: 2026,
    clubs: ["LG", "삼성"],
  });
  expect(parseKboPlayerCareerProfile(profile({ id: "54321" }), "12345")).toBeNull();
  expect(parseKboPlayerCareerProfile(profile({ games: "0" }), "12345")).toBeNull();
  expect(
    parseKboPlayerCareerProfile(profile({ history: "가상고-LG-해외구단" }), "12345"),
  ).toBeNull();
});

it("requires matching transfer direction and ordered club evidence, keeping actual return stints", () => {
  expect(parseCareerMovement({ effect: "transfer", note: "LG→삼성", team: "삼성" })).toEqual({
    from: "LG",
    to: "삼성",
  });
  expect(parseCareerMovement({ effect: "transfer", note: "LG→삼성", team: "LG" })).toBeNull();
  expect(parseCareerMovement({ effect: "transfer", note: null, team: "삼성" })).toBeNull();
  expect(parseCareerMovement({ effect: "transfer", note: "SK→SSG", team: "SSG" })).toBeNull();
  expect(careerCoversObservedClubs(["LG", "삼성", "LG"], ["LG", "삼성", "LG"])).toBe(true);
  expect(careerCoversObservedClubs(["LG", "삼성"], ["삼성", "LG"])).toBe(false);
  expect(careerCoversObservedClubs(["SK"], ["SK", "SSG"])).toBe(true);
});
