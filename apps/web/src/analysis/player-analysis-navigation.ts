import type {
  AnalysisScopeOptions,
  DisciplineCatalog,
  PitchAnalysisCatalog,
  PlayerDirectoryEntry,
  PlayerDirectorySeason,
} from "@kbo/contracts";
import {
  analysisScopeParams,
  analysisScopeSearch,
  changeAnalysisParams,
  scopeFromParams,
  type AnalysisPlayerSelection,
} from "./analysis-scope";
import { periodUrlKeys } from "./period-selection";

export type PlayerAnalysisRole = "pitcher" | "batter";
export const playerBasicPath = "/analysis/player-statistics";
export const playerRolePath = {
  batter: "/analysis/batter-profile",
  pitcher: "/analysis/pitch-location",
};

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

export function selectedPlayerRole(params: URLSearchParams): PlayerAnalysisRole {
  return params.get("playerRole") === "batter" ? "batter" : "pitcher";
}

export function playerRoleForPath(
  path: string,
  params: URLSearchParams,
): PlayerAnalysisRole | null {
  if (path === "/analysis/matchups" || path === "/analysis/player-statistics")
    return selectedPlayerRole(params);
  if (playerAnalysisSections.pitcher.some((section) => section.path === path)) return "pitcher";
  if (playerAnalysisSections.batter.some((section) => section.path === path)) return "batter";
  return null;
}

function playerScopeParams(params: URLSearchParams) {
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  return selected;
}

export function playerNavigationScope(
  path: string,
  params: URLSearchParams,
  defaultSeason?: number,
) {
  const season = Number(params.get("season") ?? defaultSeason);
  const selected = playerScopeParams(params);
  if (path === "/analysis/pitcher-changes" && !selected.has("dateTo"))
    selected.set("dateTo", `${season}-12-31`);
  return { season, ...scopeFromParams(season, selected) };
}

export function changePlayerAnalysisTarget(
  path: string,
  params: URLSearchParams,
  key: "season" | PlayerAnalysisRole,
  value: string,
  currentPlayers: AnalysisPlayerSelection,
): URLSearchParams {
  const next = changeAnalysisParams(params, key, value, currentPlayers);
  if (path === "/analysis/pitch-shape") {
    for (const filter of ["clusterCount", "cluster", "type"]) next.delete(filter);
  }
  if (path === "/analysis/batter-discipline") {
    next.delete("pitchType");
    if (key === "season") {
      next.delete("compareFrom");
      next.delete("compareTo");
    }
  }
  return next;
}

export function playerAnalysisHref(
  path: string,
  role: PlayerAnalysisRole,
  id: string,
  season: number,
  options: AnalysisScopeOptions,
  comparison?: URLSearchParams,
  identity?: string,
): string {
  const params = new URLSearchParams(analysisScopeSearch(season, options));
  params.set(role, id);
  for (const key of periodUrlKeys) {
    const value = comparison?.get(key);
    if (value !== undefined && value !== null) params.set(key, value);
  }
  if (path === "/analysis/matchups" || path === "/analysis/player-statistics")
    params.set("playerRole", role);
  if (identity !== undefined) params.set("player", identity);
  return `${path}?${params}`;
}

export function playerBasicHref(
  identity: string,
  season: number,
  params?: URLSearchParams,
): string {
  const next = params ? analysisScopeParams(params) : new URLSearchParams();
  next.set("season", String(season));
  next.set("player", identity);
  for (const key of periodUrlKeys) {
    const value = params?.get(key);
    if (value != null) next.set(key, value);
  }
  return `${playerBasicPath}?${next}`;
}

export function playerRecordId(
  record: PlayerDirectorySeason | undefined,
  role: PlayerAnalysisRole,
) {
  return (role === "batter" ? record?.battingPlayerId : record?.pitchingPlayerId) ?? null;
}

export function changePlayerReport(
  path: string,
  params: URLSearchParams,
  player: PlayerDirectoryEntry,
  season: number,
  previousSeason: number,
  currentPlayers: AnalysisPlayerSelection,
) {
  let next =
    season === previousSeason
      ? new URLSearchParams(params)
      : changePlayerAnalysisTarget(path, params, "season", String(season), currentPlayers);
  const role = playerRoleForPath(path, params);
  const record = player.seasons.find((entry) => entry.season === season);
  const id = role === null ? null : playerRecordId(record, role);
  if (path === playerBasicPath || role === null || id === null)
    return playerBasicHref(player.identity, season, next);
  if (next.get(role) !== id) {
    next = changePlayerAnalysisTarget(path, next, role, id, currentPlayers);
  }
  next.set("season", String(season));
  next.set("player", player.identity);
  return `${path}?${next}`;
}

export interface AnalysisCatalogPlayer {
  id: string;
  name: string;
  pitches: number;
}

export function analysisCatalogPlayers(
  catalog: PitchAnalysisCatalog | DisciplineCatalog,
): AnalysisCatalogPlayer[] {
  return "pitchers" in catalog
    ? catalog.pitchers.map((p) => ({ id: p.pitcherId, name: p.name, pitches: p.pitches }))
    : catalog.batters.map((p) => ({ id: p.batterId, name: p.name, pitches: p.pitches }));
}
