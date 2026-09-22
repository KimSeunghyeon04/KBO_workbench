import { expect, it } from "vitest";
import { linkKboCompetitionGames } from "@kbo/collection";
import { competitionFixture } from "../helpers/game-competition.js";

it("preserves original IDs and links exact date/team/doubleheader identity without inferring competition from prefixes", () => {
  const dataset = competitionFixture(2024, [
    { sourceGameId: "20240601AABB1", gameDate: "2024-06-01", competition: "preseason" },
    { sourceGameId: "20240601AABB2", gameDate: "2024-06-01", competition: "postseason" },
  ]);
  const games = [
    { sourceGameId: "20240601AABB12024", gameDate: "2024-06-01" },
    { sourceGameId: "77770601AABB22024", gameDate: "2024-06-01" },
    { sourceGameId: "20240601BBAA12024", gameDate: "2024-06-01" },
  ];
  expect(linkKboCompetitionGames(dataset, games)).toEqual(
    dataset.entries.map((e, i) => ({
      sourceGameId: e.sourceGameId,
      gameDate: e.gameDate,
      matchedSourceGameId: games[i]?.sourceGameId,
    })),
  );
  expect(dataset.entries[0]?.sourceGameId).toBe("20240601AABB1");
  expect(
    linkKboCompetitionGames(
      dataset,
      games.map((g) => ({ ...g, gameDate: "2024-06-02" })),
    ),
  ).toEqual([]);
  expect(
    linkKboCompetitionGames(dataset, [
      { sourceGameId: "20240601AABB12023", gameDate: "2024-06-01" },
    ]),
  ).toEqual([]);
  expect(() =>
    linkKboCompetitionGames(dataset, [
      ...games,
      { sourceGameId: "66660601AABB12024", gameDate: "2024-06-01" },
    ]),
  ).toThrow(/모호/);
});
