// Reviewed sealed-metadata names only. A shared display name does not merge different facilities.
const venues = new Map([
  ["고척", "gocheok"],
  ["광주", "gwangju"],
  ["대구", "daegu"],
  ["문학", "munhak"],
  ["사직", "sajik"],
  ["수원", "suwon"],
  ["잠실", "jamsil"],
  ["창원", "changwon"],
]);
export function analysisVenueId(season: number, stadium: string | null): string | null {
  if (stadium === "대전") return season < 2025 ? "daejeon-old" : "daejeon-new";
  if (stadium === "대전(신)" && season >= 2025) return "daejeon-new";
  return stadium === null ? null : (venues.get(stadium) ?? null);
}
export function standardAnalysisVenueIds(season: number): string[] {
  return [...venues.values(), season < 2025 ? "daejeon-old" : "daejeon-new"].sort();
}
