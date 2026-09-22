/** Explicitly supported regular-season rules; 2020/21 special schedules are unverified. */
export function winInningLimit(season: number): 11 | 12 | null {
  return season >= 2022 && season <= 2024 ? 12 : season === 2025 ? 11 : null;
}
