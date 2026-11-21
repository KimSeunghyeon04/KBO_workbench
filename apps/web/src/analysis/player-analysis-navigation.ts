import type { AnalysisScopeOptions, DisciplineCatalog, PitchAnalysisCatalog } from "@kbo/contracts";
import { analysisScopeSearch, scopeFromParams } from "./analysis-scope";
import { periodUrlKeys } from "./period-selection";

export type PlayerAnalysisRole = "pitcher" | "batter";

export const playerAnalysisSections = {
  pitcher: [
    { path: "/analysis/player-statistics", label: "기본 기록" },
    { path: "/analysis/pitch-location", label: "코스·결정구" },
    { path: "/analysis/pitch-shape", label: "구질·움직임" },
    { path: "/analysis/pitcher-changes", label: "최근 변화" },
    { path: "/analysis/pitch-sequences", label: "배합·궤적" },
    { path: "/analysis/pitcher-workload", label: "등판·운용" },
    { path: "/analysis/matchups", label: "타자와 매치업" },
  ],
  batter: [
    { path: "/analysis/player-statistics", label: "기본 기록" },
    { path: "/analysis/batter-profile", label: "반응·성적" },
    { path: "/analysis/batter-discipline", label: "선구안" },
    { path: "/analysis/matchups", label: "투수와 매치업" },
  ],
} as const;

export function playerRoleForPath(
  path: string,
  params: URLSearchParams,
): PlayerAnalysisRole | null {
  if (path === "/analysis/matchups" || path === "/analysis/player-statistics")
    return params.get("playerRole") === "batter" ? "batter" : "pitcher";
  if (playerAnalysisSections.pitcher.some((section) => section.path === path)) return "pitcher";
  if (playerAnalysisSections.batter.some((section) => section.path === path)) return "batter";
  return null;
}

/** Legacy URLs keep their page's existing default. Cross-page links make that scope explicit. */
export function playerNavigationScope(path: string, params: URLSearchParams, defaultSeason = 2025) {
  const season = Number(params.get("season") ?? defaultSeason);
  const legacyShape = path === "/analysis/pitch-shape";
  const legacyDiscipline = path === "/analysis/batter-discipline";
  const selected = new URLSearchParams(params);
  if (!selected.has("competition"))
    selected.set("competition", legacyShape || legacyDiscipline ? "all" : "regular");
  if (path === "/analysis/pitcher-changes" && !selected.has("dateTo"))
    selected.set("dateTo", `${season}-12-31`);
  return { season, ...scopeFromParams(season, selected) };
}

export function playerAnalysisHref(
  path: string,
  role: PlayerAnalysisRole,
  id: string,
  season: number,
  options: AnalysisScopeOptions,
  comparison?: URLSearchParams,
): string {
  const params = new URLSearchParams(analysisScopeSearch(season, options));
  params.set(role, id);
  for (const key of periodUrlKeys) {
    const value = comparison?.get(key);
    if (value !== undefined && value !== null) params.set(key, value);
  }
  if (path === "/analysis/matchups" || path === "/analysis/player-statistics")
    params.set("playerRole", role);
  return `${path}?${params}`;
}

export function playerDirectoryHref(
  role: PlayerAnalysisRole,
  season: number,
  options: AnalysisScopeOptions,
): string {
  const params = new URLSearchParams(analysisScopeSearch(season, options));
  params.set("role", role);
  return `/analysis/players?${params}`;
}

export function analysisCatalogPlayers(catalog: PitchAnalysisCatalog | DisciplineCatalog) {
  return "pitchers" in catalog
    ? catalog.pitchers.map((p) => ({ id: p.pitcherId, name: p.name, pitches: p.pitches }))
    : catalog.batters.map((p) => ({ id: p.batterId, name: p.name, pitches: p.pitches }));
}
