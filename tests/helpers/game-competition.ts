import { createHash } from "node:crypto";
import {
  parseGameCompetitionDataset,
  type CompetitionEntry,
  type GameCompetition,
} from "@kbo/contracts";

export function competitionFixture(season: number, entries: Omit<CompetitionEntry, "pageHash">[]) {
  const pages = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((month) =>
    (["preseason", "regular", "postseason"] as const).map((competition) => ({
      month,
      competition,
      sourceUrl: "https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList",
      contentHash: createHash("sha256").update(`${month}:${competition}`).digest("hex"),
      artifactKey: `test/${month}/${competition}`,
      collectedAt: "2026-09-20T00:00:00Z",
    })),
  );
  const hash = (date: string, kind: GameCompetition) => {
    const page = pages.find((p) => p.month === Number(date.slice(5, 7)) && p.competition === kind);
    if (page === undefined) throw new Error("Invalid fixture date");
    return page.contentHash;
  };
  return parseGameCompetitionDataset({
    version: 1,
    season,
    pages,
    entries: entries.map((row) => ({ ...row, pageHash: hash(row.gameDate, row.competition) })),
  });
}
