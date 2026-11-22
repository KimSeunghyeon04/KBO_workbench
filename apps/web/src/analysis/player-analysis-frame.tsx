import { AnalysisSeasonOptions, useAnalysisSeason } from "./analysis-seasons";
import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import type { DisciplineCatalog, PitchAnalysisCatalog } from "@kbo/contracts";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import {
  analysisCatalogPlayers,
  changePlayerAnalysisTarget,
  playerAnalysisHref,
  playerAnalysisSections,
  playerNavigationScope,
  playerRoleForPath,
  type PlayerAnalysisRole,
} from "./player-analysis-navigation";
import { PlayerAnalysisSearch } from "./player-analysis-search";
import { analysisScopeSummary } from "./analysis-scope-fields";
import { analysisScopeSearch, type AnalysisPlayerSelection } from "./analysis-scope";
import "../styles/player-analysis-frame.css";

function PlayerNavigation({ role, path }: { role: PlayerAnalysisRole; path: string }) {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [previousPlayer, setPreviousPlayer] = useState<{
    role: PlayerAnalysisRole;
    id: string;
    name: string;
  }>();
  const navigation = useRef<HTMLElement>(null);
  const defaultSeason = useAnalysisSeason(params.get("season"));
  const scope = playerNavigationScope(path, params, defaultSeason);
  // Observe the page's catalog cache. The analysis page remains the request owner,
  // so this navigation never adds a catalog request or starts another analysis.
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
  const requestedId = params.get(role);
  const requestedPlayer = catalog.data?.find((player) => player.id === requestedId);
  const player = requestedPlayer ?? (requestedId === null ? catalog.data?.[0] : undefined);
  const id = player?.id ?? requestedId;
  const hasNavigation = scope.error === null && id !== null && id !== "";
  useEffect(() => {
    const nav = navigation.current;
    if (!hasNavigation || !nav) return;
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
  }, [hasNavigation, path, role]);
  const knownName =
    player?.name ??
    (previousPlayer?.role === role && previousPlayer.id === id ? previousPlayer.name : undefined);

  function changeTarget(key: "season" | PlayerAnalysisRole, value: string) {
    const currentPlayers: AnalysisPlayerSelection = id ? { [role]: id } : {};
    if (key === "season") {
      if (player) setPreviousPlayer({ role, id: player.id, name: player.name });
      if (path === "/analysis/matchups") {
        // Pin the current opponent if the page selected a catalog default.
        const opponent = role === "pitcher" ? "batter" : "pitcher";
        if (!params.has(opponent)) {
          const { queryKey } =
            opponent === "batter"
              ? batterCatalogQueryOptions(scope.season, scope.options)
              : pitcherCatalogQueryOptions(scope.season, scope.options);
          const cached = queryClient.getQueryData<PitchAnalysisCatalog | DisciplineCatalog>(
            queryKey,
          );
          const first = cached && ("batters" in cached ? cached.batters[0] : cached.pitchers[0]);
          if (first)
            currentPlayers[opponent] = "batterId" in first ? first.batterId : first.pitcherId;
        }
      }
    }
    setParams(changePlayerAnalysisTarget(path, params, key, value, currentPlayers), {
      preventScrollReset: true,
    });
  }

  const unavailable =
    scope.error !== null
      ? "조회 범위를 확인해 주세요."
      : catalog.isError
        ? "선수 목록을 읽지 못했습니다."
        : "선수 목록을 읽고 있습니다.";
  return (
    <section className="player-analysis-context" aria-label="현재 선수 분석">
      <div className="player-analysis-context-heading">
        <div className="player-analysis-identity">
          <div className="player-analysis-name">
            <strong>
              {knownName ??
                (catalog.isFetching ? "선수 확인 중" : id ? `선수 ${id}` : "선수를 선택하세요")}
            </strong>
            <span className="player-role-label">{role === "pitcher" ? "투수" : "타자"}</span>
            {id && <span className="player-analysis-id">ID {id}</span>}
          </div>
          <span className="player-analysis-period">
            {scope.error === null
              ? analysisScopeSummary(
                  new URLSearchParams(analysisScopeSearch(scope.season, scope.options)),
                )
              : "조회 범위 확인 필요"}
          </span>
        </div>
        <div className="player-analysis-actions">
          <div className="player-analysis-inputs">
            <PlayerAnalysisSearch
              key={`${role}:${scope.season}`}
              players={scope.error === null ? catalog.data : undefined}
              selectedId={id}
              unavailable={unavailable}
              onSelect={(nextPlayer) => changeTarget(role, nextPlayer.id)}
            />
            <select
              className="player-analysis-season"
              aria-label="분석 시즌"
              value={scope.season}
              onChange={(event) => changeTarget("season", event.target.value)}
            >
              <AnalysisSeasonOptions season={scope.season} labelSuffix=" 시즌" />
            </select>
          </div>
          {scope.error === null && player && (
            <div className="player-catalog-sample">
              <span>{role === "pitcher" ? "범위 내 투구" : "범위 내 상대 투구"}</span>
              <strong>
                {player.pitches.toLocaleString()}
                <small>구</small>
              </strong>
            </div>
          )}
          {scope.error === null && id && catalog.isSuccess && player === undefined && (
            <span className="player-catalog-missing" role="status">
              해당 범위 기록 없음
            </span>
          )}
        </div>
      </div>
      {hasNavigation && (
        <nav ref={navigation} className="player-analysis-links" aria-label="선수 분석 항목">
          {playerAnalysisSections[role].map((section) => (
            <NavLink
              key={section.path}
              to={
                section.path === path
                  ? `${path}?${params}`
                  : playerAnalysisHref(section.path, role, id, scope.season, scope.options, params)
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
  const params = new URLSearchParams(location.search);
  const role = playerRoleForPath(location.pathname, params);
  return role === null ? (
    children
  ) : (
    <div className="player-analysis-frame">
      <PlayerNavigation role={role} path={location.pathname} />
      {children}
    </div>
  );
}
