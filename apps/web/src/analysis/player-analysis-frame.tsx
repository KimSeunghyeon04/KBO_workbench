import type { PropsWithChildren } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { DisciplineCatalog, PitchAnalysisCatalog } from "@kbo/contracts";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import {
  analysisCatalogPlayers,
  playerAnalysisHref,
  playerAnalysisSections,
  playerDirectoryHref,
  playerNavigationScope,
  playerRoleForPath,
  type PlayerAnalysisRole,
} from "./player-analysis-navigation";
import { analysisScopeSummary } from "./analysis-scope-fields";
import { analysisScopeSearch } from "./analysis-scope";
import "../styles/player-analysis-frame.css";

function PlayerNavigation({
  role,
  path,
  params,
}: {
  role: PlayerAnalysisRole;
  path: string;
  params: URLSearchParams;
}) {
  const scope = playerNavigationScope(path, params);
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
  const player =
    requestedPlayer ??
    (requestedId === null || path === "/analysis/pitch-shape" ? catalog.data?.[0] : undefined);
  const id = player?.id ?? requestedId;
  const directory =
    scope.error === null
      ? playerDirectoryHref(role, scope.season, scope.options)
      : `/analysis/players?role=${role}`;
  return (
    <section className="player-analysis-context" aria-label="현재 선수 분석">
      <div className="player-analysis-context-heading">
        <div className="player-analysis-identity">
          <span className="player-report-label">선수 리포트</span>
          <div className="player-analysis-name">
            <strong>
              {player?.name ??
                (catalog.isFetching ? "선수 확인 중" : id ? `선수 ${id}` : "선수를 선택하세요")}
            </strong>
            <span className="player-role-label">{role === "pitcher" ? "투수" : "타자"}</span>
            {id && <span className="player-analysis-id">ID {id}</span>}
          </div>
          <span className="player-analysis-period">
            {scope.season} ·{" "}
            {scope.error === null
              ? analysisScopeSummary(
                  new URLSearchParams(analysisScopeSearch(scope.season, scope.options)),
                )
              : "조회 범위 확인 필요"}
          </span>
        </div>
        <div className="player-analysis-actions">
          {scope.error === null && player && (
            <div className="player-catalog-sample">
              <span>{role === "pitcher" ? "범위 내 투구" : "범위 내 상대 투구"}</span>
              <strong>
                {player.pitches.toLocaleString()}
                <small>구</small>
              </strong>
            </div>
          )}
          <Link className="player-directory-link" to={directory}>
            선수 변경 <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
      {scope.error === null && id && (
        <nav className="player-analysis-links" aria-label="선수 분석 항목">
          {playerAnalysisSections[role].map((section) => (
            <NavLink
              key={section.path}
              to={
                section.path === path
                  ? `${path}?${params}`
                  : playerAnalysisHref(section.path, role, id, scope.season, scope.options)
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
      <PlayerNavigation role={role} path={location.pathname} params={params} />
      {children}
    </div>
  );
}
