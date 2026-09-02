import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RawGameBundle } from "@kbo/collection";

export async function sanitizedNaverBundle(): Promise<RawGameBundle> {
  return JSON.parse(
    await readFile(path.resolve("tests/fixtures/naver/sanitized-game-bundle.json"), "utf8"),
  ) as RawGameBundle;
}

export function schedulePayload(games: readonly unknown[], total = games.length): unknown {
  return { code: 200, success: true, result: { games, gameTotalCount: total } };
}

export function scheduleGame(
  gameId: string,
  gameDate: string,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    gameId,
    gameDate,
    gameDateTime: `${gameDate}T18:30:00`,
    categoryId: "kbo",
    statusCode: "RESULT",
    cancel: false,
    awayTeamName: "원정",
    homeTeamName: "홈",
    ...overrides,
  };
}
