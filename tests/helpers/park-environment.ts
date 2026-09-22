import type { ParkEnvironmentRow } from "@kbo/contracts";
export function parkEnvironmentRows(season: number, games = 240): ParkEnvironmentRow[] {
  return Array.from({ length: games }, (_, i) => {
    const park = i % 4,
      away = Math.floor(i / 4) % 6,
      home = (away + 1 + (Math.floor(i / 24) % 5)) % 6;
    return (["away", "home"] as const).map((side) => ({
      gameId: `${season}-${String(i).padStart(4, "0")}`,
      revision: 1,
      season,
      gameDate: `${season}-06-01`,
      documentHash: "a".repeat(64),
      stadium: `구장${park}`,
      parkId: `park${park}`,
      teamId: `team${side === "away" ? away : home}`,
      opponentId: `team${side === "away" ? home : away}`,
      side,
      normalEnd: true,
      pa: 40,
      homeRuns: 1 + Number(park === 0) * 4 + (i % 3 === 0 ? 1 : 0),
      runs: 3 + park + (i % 3),
      completeHalves: 8,
      completeRuns: 3 + park + (i % 3),
      excludedHalves: 1,
    }));
  }).flat();
}
