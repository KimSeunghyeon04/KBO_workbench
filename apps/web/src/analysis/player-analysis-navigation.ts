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
export const playerGamesPath = "/analysis/player-games";
export const playerSplitsPath = "/analysis/player-splits";
export const playerRolePath = {
  batter: "/analysis/batter-profile",
  pitcher: "/analysis/pitch-location",
};
const matchupPath = "/analysis/matchups";
const sharedPlayerPaths: ReadonlySet<string> = new Set([
  playerBasicPath,
  playerGamesPath,
  playerSplitsPath,
  matchupPath,
]);
const recordSections = [
  { path: playerBasicPath, tab: "basic" },
  { path: playerGamesPath, tab: "games" },
  { path: playerSplitsPath, tab: "splits" },
] as const;

export const playerAnalysisSections = {
  pitcher: [
    ...recordSections,
    { path: playerRolePath.pitcher, tab: "pitches" },
    { path: "/analysis/pitch-shape", tab: "pitches" },
    { path: "/analysis/pitcher-changes", tab: "games" },
    { path: "/analysis/pitch-sequences", tab: "pitches" },
    { path: "/analysis/pitcher-workload", tab: "games" },
    { path: matchupPath, tab: "matchup" },
  ],
  batter: [
    ...recordSections,
    { path: playerRolePath.batter, tab: "pitches" },
    { path: "/analysis/batter-discipline", tab: "pitches" },
    { path: matchupPath, tab: "matchup" },
  ],
} as const;

export const playerReportTabs = [
  { tab: "basic", label: "기본 기록" },
  { tab: "games", label: "경기별" },
  { tab: "splits", label: "상황별" },
  { tab: "pitches", label: "구종·코스" },
  { tab: "matchup", label: "맞대결" },
] as const;
export type PlayerReportTab = (typeof playerReportTabs)[number]["tab"];

export function playerReportTabPath(tab: PlayerReportTab, role: PlayerAnalysisRole) {
  return {
    basic: playerBasicPath,
    games: playerGamesPath,
    splits: playerSplitsPath,
    pitches: playerRolePath[role],
    matchup: matchupPath,
  }[tab];
}

export function selectedPlayerRole(params: URLSearchParams): PlayerAnalysisRole {
  const requested = params.get("playerRole");
  if (requested === "batter" || requested === "pitcher") return requested;
  return params.has("batter") && !params.has("pitcher") ? "batter" : "pitcher";
}

export function playerRoleForPath(
  path: string,
  params: URLSearchParams,
): PlayerAnalysisRole | null {
  if (sharedPlayerPaths.has(path)) return selectedPlayerRole(params);
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
  if (sharedPlayerPaths.has(path)) params.set("playerRole", role);
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
  const role = params?.get("playerRole");
  if (role === "batter" || role === "pitcher") next.set("playerRole", role);
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

export function playerRoleForRecord(
  record: PlayerDirectorySeason | undefined,
  preferred: PlayerAnalysisRole,
): PlayerAnalysisRole {
  const other = preferred === "batter" ? "pitcher" : "batter";
  return playerRecordId(record, preferred) === null && playerRecordId(record, other) !== null
    ? other
    : preferred;
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
  const requestedRole = playerRoleForPath(path, params);
  const record = player.seasons.find((entry) => entry.season === season);
  const role =
    (path === playerGamesPath || path === playerSplitsPath) && requestedRole !== null
      ? playerRoleForRecord(record, requestedRole)
      : requestedRole;
  const id = role === null ? null : playerRecordId(record, role);
  if (path === playerBasicPath || role === null || id === null)
    return playerBasicHref(player.identity, season, next);
  if (next.get(role) !== id) {
    next = changePlayerAnalysisTarget(path, next, role, id, currentPlayers);
  }
  next.set("season", String(season));
  next.set("player", player.identity);
  if (sharedPlayerPaths.has(path)) next.set("playerRole", role);
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
