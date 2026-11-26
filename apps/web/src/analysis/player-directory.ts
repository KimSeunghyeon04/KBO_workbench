import { PlayerDirectorySchema, type PlayerDirectoryEntry } from "@kbo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import { requestJson } from "../api/transport";

export const playerDirectoryQueryKey = ["analysis-player-directory"] as const;

export function usePlayerDirectory() {
  return useQuery({
    queryKey: playerDirectoryQueryKey,
    queryFn: async ({ signal }) =>
      Value.Decode(
        PlayerDirectorySchema,
        await requestJson("/api/v2/analysis/players", { signal }),
      ),
    meta: { analysis: { seasons: "all", usesModels: false } },
    staleTime: 60_000,
  });
}

export function normalizePlayerSearch(value: string) {
  return value.trim().normalize("NFC").toLowerCase();
}

export function filterDirectoryPlayers(players: readonly PlayerDirectoryEntry[], query: string) {
  const needle = normalizePlayerSearch(query);
  return players.filter(
    (player) =>
      normalizePlayerSearch(player.name).includes(needle) ||
      player.sourceIds.some((id) => normalizePlayerSearch(id).includes(needle)),
  );
}

export function findDirectoryPlayer(
  players: readonly PlayerDirectoryEntry[] | undefined,
  identity: string | null,
  sourceId: string | null,
) {
  return players?.find((player) =>
    identity !== null
      ? player.identity === identity
      : sourceId !== null && player.sourceIds.includes(sourceId),
  );
}

export function playerCareer(player: PlayerDirectoryEntry) {
  const career = player.career;
  const first = career?.firstSeason ?? player.seasons.at(-1)?.season;
  const last = career?.lastSeason ?? player.seasons[0]?.season;
  const range = first === last ? String(last) : `${first}–${last}`;
  const teams = career ? career.clubs.map(({ name }) => name) : player.teams;
  return {
    period: `${career ? "프로 경력" : "수집 기록"} ${range}`,
    teams: teams.join(" → ") || "팀 이력 미확인",
  };
}

export function playerPosition(player: PlayerDirectoryEntry) {
  return player.primaryPosition ?? "포지션 미확인";
}

export function playerBirthYearLabel(player: PlayerDirectoryEntry) {
  return player.birthYear === undefined ? "출생연도 미확인" : `${player.birthYear}년생`;
}
