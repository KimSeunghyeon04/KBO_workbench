import type { CompetitionGameLink, GameCompetitionDataset } from "@kbo/contracts";

// Only provider identity syntax belongs here. Competition always comes from the official page.
function key(id: string, date: string, naver: boolean): string | null {
  const match = /^(\d{4})(\d{4})([A-Z]{4})([0-2])(\d{4})?$/.exec(id);
  if (match === null || match[2] !== date.slice(5).replace("-", "")) return null;
  const year = date.slice(0, 4);
  if (naver) {
    if (
      match[5] !== year ||
      (match[1] !== year &&
        !["3333", "4444", "5555", "6666", "7777", "9999"].includes(match[1] ?? ""))
    )
      return null;
  } else if (match[1] !== year || match[5] !== undefined) return null;
  return `${date}:${match[3]}:${match[4]}`;
}

export function linkKboCompetitionGames(
  dataset: GameCompetitionDataset,
  games: readonly { sourceGameId: string; gameDate: string }[],
): CompetitionGameLink[] {
  const byKey = new Map<string, (typeof games)[number][]>();
  for (const game of games) {
    const identity = key(game.sourceGameId, game.gameDate, true);
    if (identity === null) continue;
    const rows = byKey.get(identity) ?? [];
    rows.push(game);
    byKey.set(identity, rows);
  }
  const links: CompetitionGameLink[] = [];
  for (const entry of dataset.entries) {
    const identity = key(entry.sourceGameId, entry.gameDate, false);
    const candidates = identity === null ? [] : (byKey.get(identity) ?? []);
    if (candidates.length > 1)
      throw new Error(`공식 일정의 제공자 ID 연결이 모호합니다: ${entry.sourceGameId}`);
    const candidate = candidates[0];
    if (candidate !== undefined)
      links.push({
        sourceGameId: entry.sourceGameId,
        matchedSourceGameId: candidate.sourceGameId,
        gameDate: entry.gameDate,
      });
  }
  return links;
}
