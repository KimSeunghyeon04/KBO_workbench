import { createHash } from "node:crypto";
import {
  parseGameCompetitionDataset,
  type CompetitionEntry,
  type GameCompetition,
  type GameCompetitionDataset,
} from "@kbo/contracts";

export function competitionFixture(season: number, entries: Omit<CompetitionEntry, "pageHash">[]) {
  const pages: GameCompetitionDataset["pages"] = Array.from(
    { length: 12 },
    (_, i) => i + 1,
  ).flatMap((month) =>
    (["preseason", "regular", "postseason"] as const).map((competition) => ({
      month,
      competition,
      sourceUrl: "https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList",
      contentHash: createHash("sha256").update(`${month}:${competition}`).digest("hex"),
      artifactKey: `test/${month}/${competition}`,
      collectedAt: "2026-09-20T00:00:00Z",
    })),
  );
  for (const { gameDate, competition } of entries) {
    if (competition !== "allstar") continue;
    const month = Number(gameDate.slice(5, 7)),
      day = Number(gameDate.slice(8, 10));
    if (pages.some((page) => page.day === day && page.month === month)) continue;
    pages.push({
      month,
      day,
      competition,
      sourceUrl: "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList",
      contentHash: createHash("sha256").update(gameDate).digest("hex"),
      artifactKey: `test/${month}/${day}/${competition}`,
      collectedAt: "2026-09-20T00:00:00Z",
    });
  }
  const hash = (date: string, kind: GameCompetition) => {
    const page = pages.find(
      (p) =>
        p.month === Number(date.slice(5, 7)) &&
        p.competition === kind &&
        (p.day === undefined || p.day === Number(date.slice(8, 10))),
    );
    if (page === undefined) throw new Error("Invalid fixture date");
    return page.contentHash;
  };
  return parseGameCompetitionDataset({
    version: pages.length === 36 ? 1 : 2,
    season,
    pages,
    entries: entries.map((row) => ({ ...row, pageHash: hash(row.gameDate, row.competition) })),
  });
}
