import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import { Link, useLocation } from "react-router-dom";

import {
  playerAnalysisSections,
  playerDirectoryHref,
  playerNavigationScope,
  playerRoleForPath,
} from "../analysis/player-analysis-navigation";

const managementNavigation = [
  { to: "/", label: "대시보드", end: true },
  { to: "/collect", label: "수집", end: false },
  { to: "/correct", label: "보정", end: false },
  { to: "/record-corrections", label: "기록정정", end: false },
  { to: "/database", label: "데이터베이스", end: false },
  { to: "/settings", label: "설정 및 진단", end: false },
] as const;

type Workspace = "management" | "analysis";
const analysisGroups = [
  { label: "선수", items: [{ to: "/analysis/players", label: "선수 분석", end: false }] },
  {
    label: "리그·경기",
    items: [
      { to: "/analysis/statistics", label: "선수·팀 성적", end: false },
      { to: "/analysis/baserunning", label: "주루와 추가 진루", end: false },
      { to: "/analysis/park-environment", label: "구장 득점 환경", end: false },
      { to: "/replay", label: "경기 재생", end: false },
    ],
  },
  {
    label: "분석 관리",
    items: [
      { to: "/analysis/coverage", label: "분석 자료 품질", end: false },
      { to: "/analysis/models", label: "분석 모델 관리", end: false },
    ],
  },
];
const knownAnalysisPaths = new Set([
  "/analysis",
  ...analysisGroups.flatMap((group) => group.items.map((item) => item.to)),
  ...Object.values(playerAnalysisSections).flatMap((sections) =>
    sections.map((section) => section.path),
  ),
]);
function workspaceFor(path: string): Workspace {
  return path === "/analysis" || path.startsWith("/analysis/") || path === "/replay"
    ? "analysis"
    : "management";
}
function lastLocation(workspace: Workspace): string {
  const fallback = workspace === "analysis" ? "/analysis/players" : "/";
  try {
    const value = sessionStorage.getItem(`kbo.workspace.${workspace}`);
    if (value === null || !value.startsWith("/") || value.startsWith("//")) return fallback;
    const path = value.split(/[?#]/u)[0] ?? "";
    const known =
      managementNavigation.some((item) => item.to === path) || knownAnalysisPaths.has(path);
    return known && workspaceFor(path) === workspace ? value : fallback;
  } catch {
    return fallback;
  }
}

export function AppShell({ children }: PropsWithChildren): React.JSX.Element {
  const location = useLocation();
  const workspace = workspaceFor(location.pathname);
  const params = new URLSearchParams(location.search);
  const playerRole = playerRoleForPath(location.pathname, params);
  const playerScope = playerNavigationScope(location.pathname, params);
  const playerDestination =
    location.pathname === "/analysis/players" || location.pathname === "/analysis"
      ? location.pathname + location.search
      : playerRole && playerScope.error === null
        ? playerDirectoryHref(playerRole, playerScope.season, playerScope.options)
        : "/analysis/players";
  const groups =
    workspace === "analysis"
      ? analysisGroups
      : [{ label: "데이터 관리", items: managementNavigation }];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    function closeOutside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !navigation.current?.contains(event.target) &&
        !menuButton.current?.contains(event.target)
      )
        setMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        `kbo.workspace.${workspace}`,
        location.pathname + location.search + location.hash,
      );
    } catch {
      // Navigation remains usable when browser storage is unavailable.
    }
  }, [workspace, location.pathname, location.search, location.hash]);
  return (
    <div
      className="app-shell"
      data-workspace={workspace}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          event.preventDefault();
          setMenuOpen(false);
          menuButton.current?.focus();
        }
      }}
    >
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          setMenuOpen(false);
          main.current?.focus();
        }}
      >
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <strong className="brand-name">KBO Workbench</strong>
        <nav className="workspace-switch" aria-label="작업 영역">
          <Link
            to={workspace === "management" ? location : lastLocation("management")}
            aria-current={workspace === "management" ? "page" : undefined}
          >
            데이터 관리
          </Link>
          <Link
            to={workspace === "analysis" ? location : lastLocation("analysis")}
            aria-current={workspace === "analysis" ? "page" : undefined}
          >
            분석
          </Link>
        </nav>
        <div className="topbar-actions">
          <span className="environment-label">로컬</span>
          <button
            ref={menuButton}
            type="button"
            className="mobile-menu-button"
            aria-expanded={menuOpen}
            aria-controls="primary-navigation"
            onClick={() => setMenuOpen((current) => !current)}
          >
            메뉴
          </button>
        </div>
      </header>
      <div className="body-grid">
        <nav
          ref={navigation}
          id="primary-navigation"
          className={menuOpen ? "sidebar open" : "sidebar"}
          aria-label="주 메뉴"
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              event.relatedTarget !== menuButton.current
            )
              setMenuOpen(false);
          }}
        >
          {groups.map((group) => (
            <div className="navigation-group" key={group.label}>
              <h2 className="sidebar-section-label">{group.label}</h2>
              {group.items.map((item) => {
                const active =
                  (item.to === "/analysis/players" &&
                    (playerRole !== null || location.pathname === "/analysis")) ||
                  location.pathname === item.to ||
                  (!item.end && location.pathname.startsWith(item.to + "/"));
                return (
                  <Link
                    key={item.to}
                    to={item.to === "/analysis/players" ? playerDestination : item.to}
                    aria-current={active ? "page" : undefined}
                    className={active ? "nav-link active" : "nav-link"}
                    onClick={(event) => {
                      if (
                        menuOpen &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        !event.altKey &&
                        event.button === 0
                      ) {
                        setMenuOpen(false);
                        main.current?.focus();
                      }
                    }}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <main ref={main} id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
