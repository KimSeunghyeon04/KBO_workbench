import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { DisciplineCatalog, PitchAnalysisCatalog, PlayerDirectoryEntry } from "@kbo/contracts";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { AnalysisSeasonOptions, useAnalysisSeason } from "./analysis-seasons";
import {
  analysisCatalogPlayers,
  changePlayerAnalysisTarget,
  changePlayerReport,
  playerAnalysisHref,
  playerAnalysisSections,
  playerBasicHref,
  playerBasicPath,
  playerNavigationScope,
  playerRecordId,
  playerRoleForPath,
  playerRolePath,
  type PlayerAnalysisRole,
} from "./player-analysis-navigation";
import { PlayerAnalysisSearch } from "./player-analysis-search";
import { findDirectoryPlayer, playerCareer, usePlayerDirectory } from "./player-directory";
import { analysisScopeSummary } from "./analysis-scope-fields";
import { analysisScopeSearch, type AnalysisPlayerSelection } from "./analysis-scope";
import "../styles/player-analysis-frame.css";

function PlayerNavigation({ role, path }: { role: PlayerAnalysisRole; path: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const directory = usePlayerDirectory();
  const defaultSeason = useAnalysisSeason(params.get("season"));
  const scope = playerNavigationScope(path, params, defaultSeason);
  const secondary = useRef<HTMLElement>(null);
  const [previousCatalogPlayer, setPreviousCatalogPlayer] = useState<{
    id: string;
    role: PlayerAnalysisRole;
    name: string;
  }>();
  // Legacy links can omit the role's provider ID. The feature page owns that catalog query.
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof analysisCatalogPlayers>
  >({
    ...(role === "pitcher"
      ? pitcherCatalogQueryOptions(scope.season, scope.options)
      : batterCatalogQueryOptions(scope.season, scope.options)),
    enabled: false,
    select: analysisCatalogPlayers,
  });
  const identity = params.get("player");
  const requestedId = params.get(role);
  const catalogPlayer =
    requestedId === null
      ? catalog.data?.[0]
      : catalog.data?.find((entry) => entry.id === requestedId);
  const legacyId = requestedId ?? catalogPlayer?.id ?? null;
  const player = findDirectoryPlayer(directory.data, identity, legacyId);
  const record = player?.seasons.find((entry) => entry.season === scope.season);
  const featureId = playerRecordId(record, role);
  const id = featureId ?? (identity === null ? legacyId : null);
  const basic = path === playerBasicPath;
  const showSecondary = !basic && featureId !== null && scope.error === null;

  useEffect(() => {
    const nav = secondary.current;
    if (!showSecondary || !nav) return;
    const revealCurrent = () => {
      const current = nav.querySelector('[aria-current="page"]');
      if (!current || nav.scrollWidth <= nav.clientWidth) return;
      const bounds = nav.getBoundingClientRect();
      const selected = current.getBoundingClientRect();
      if (selected.left < bounds.left) nav.scrollLeft += selected.left - bounds.left;
      else if (selected.right > bounds.right) nav.scrollLeft += selected.right - bounds.right;
    };
    revealCurrent();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealCurrent);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [path, role, showSecondary]);

  function seasonPlayers(): AnalysisPlayerSelection {
    const current: AnalysisPlayerSelection = id ? { [role]: id } : {};
    if (path !== "/analysis/matchups") return current;
    const opponent = role === "pitcher" ? "batter" : "pitcher";
    if (params.has(opponent)) return current;
    const { queryKey } =
      opponent === "batter"
        ? batterCatalogQueryOptions(scope.season, scope.options)
        : pitcherCatalogQueryOptions(scope.season, scope.options);
    const cache = queryClient.getQueryData<PitchAnalysisCatalog | DisciplineCatalog>(queryKey);
    const first = cache && ("batters" in cache ? cache.batters[0] : cache.pitchers[0]);
    if (first) current[opponent] = "batterId" in first ? first.batterId : first.pitcherId;
    return current;
  }

  function openReport(nextPlayer: PlayerDirectoryEntry, season: number) {
    const validParams = scope.error === null ? params : new URLSearchParams({ playerRole: role });
    navigate(
      changePlayerReport(path, validParams, nextPlayer, season, scope.season, seasonPlayers()),
      {
        preventScrollReset: true,
      },
    );
  }

  function chooseSeason(season: string) {
    if (player) openReport(player, Number(season));
    else {
      if (catalogPlayer) setPreviousCatalogPlayer({ ...catalogPlayer, role });
      setParams(changePlayerAnalysisTarget(path, params, "season", season, seasonPlayers()), {
        preventScrollReset: true,
      });
    }
  }

  const legacyName =
    catalogPlayer?.name ??
    (previousCatalogPlayer?.id === legacyId && previousCatalogPlayer.role === role
      ? previousCatalogPlayer.name
      : undefined);
  const name = player?.name ?? (identity === null ? legacyName : undefined);
  const career = player && playerCareer(player);
  const reportId = player?.sourceIds[0] ?? legacyId;
  const basicHref = player
    ? basic
      ? `${path}?${params}`
      : playerBasicHref(player.identity, scope.season, params)
    : id && scope.error === null
      ? playerAnalysisHref(playerBasicPath, role, id, scope.season, scope.options, params)
      : null;

  return (
    <section className="player-analysis-context" aria-label="현재 선수 분석">
      <div className="player-analysis-context-heading">
        <div className="player-analysis-identity">
          <div className="player-analysis-name">
            <strong>
              {name ??
                (catalog.isFetching || directory.isPending
                  ? "선수 확인 중"
                  : legacyId
                    ? `선수 ${legacyId}`
                    : "선수를 선택하세요")}
            </strong>
            {reportId && <span className="player-analysis-id">ID {reportId}</span>}
          </div>
          {career && (
            <span className="player-analysis-period">
              {career.period} · {career.teams}
            </span>
          )}
          {scope.error === null && id && catalog.isSuccess && !catalogPlayer && !player && (
            <span className="player-catalog-missing" role="status">
              해당 범위 기록 없음
            </span>
          )}
        </div>
        <div className="player-analysis-actions">
          <PlayerAnalysisSearch
            players={directory.data}
            selectedId={player?.identity ?? null}
            unavailable={
              directory.isError ? "선수 목록을 읽지 못했습니다." : "선수 목록을 읽고 있습니다."
            }
            retry={
              directory.isError && !directory.isFetching
                ? () => void directory.refetch()
                : undefined
            }
            onSelect={(nextPlayer) => {
              const season =
                nextPlayer.seasons.find((entry) => entry.season === scope.season) ??
                nextPlayer.seasons[0];
              if (season) openReport(nextPlayer, season.season);
            }}
          />
        </div>
      </div>
      <div className="player-analysis-scope">
        <select
          className="player-analysis-season"
          aria-label="분석 시즌"
          value={scope.season}
          onChange={(event) => chooseSeason(event.target.value)}
        >
          {player ? (
            <>
              {!record && (
                <option value={scope.season} disabled>
                  {scope.season} 시즌
                </option>
              )}
              {player.seasons.map(({ season }) => (
                <option key={season} value={season}>
                  {season} 시즌
                </option>
              ))}
            </>
          ) : (
            <AnalysisSeasonOptions season={scope.season} labelSuffix=" 시즌" />
          )}
        </select>
        <span className="player-analysis-scope-summary">
          {scope.error === null
            ? analysisScopeSummary(
                new URLSearchParams(analysisScopeSearch(scope.season, scope.options)),
              )
            : "조회 범위 확인 필요"}
        </span>
      </div>
      {basicHref && (
        <nav className="player-analysis-links player-analysis-primary" aria-label="선수 기록 보기">
          <Link
            to={basicHref}
            className={basic ? "selected" : undefined}
            aria-current={basic ? "page" : undefined}
          >
            기본 기록
          </Link>
          {(["batter", "pitcher"] as const).map((targetRole) => {
            const targetId = playerRecordId(record, targetRole);
            if (!targetId || scope.error !== null) return null;
            const active = !basic && role === targetRole;
            return (
              <Link
                key={targetRole}
                to={
                  active
                    ? `${path}?${params}`
                    : playerAnalysisHref(
                        playerRolePath[targetRole],
                        targetRole,
                        targetId,
                        scope.season,
                        scope.options,
                        params,
                        player?.identity,
                      )
                }
                className={active ? "selected" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {targetRole === "batter" ? "타격 분석" : "투구 분석"}
              </Link>
            );
          })}
        </nav>
      )}
      {showSecondary && (
        <nav
          ref={secondary}
          className="player-analysis-links player-analysis-secondary"
          aria-label="선수 분석 항목"
        >
          {playerAnalysisSections[role]
            .filter((section) => section.path !== playerBasicPath)
            .map((section) => (
              <NavLink
                key={section.path}
                to={
                  section.path === path
                    ? `${path}?${params}`
                    : playerAnalysisHref(
                        section.path,
                        role,
                        featureId,
                        scope.season,
                        scope.options,
                        params,
                        player?.identity,
                      )
                }
                className={({ isActive }) => (isActive ? "selected" : undefined)}
              >
                {section.label}
              </NavLink>
            ))}
        </nav>
      )}
    </section>
  );
}

export function PlayerAnalysisFrame({ children }: PropsWithChildren) {
  const location = useLocation();
  const role = playerRoleForPath(location.pathname, new URLSearchParams(location.search));
  return role === null ? (
    children
  ) : (
    <div className="player-analysis-frame">
      <PlayerNavigation role={role} path={location.pathname} />
      {children}
    </div>
  );
}
