import { useEffect, useState, type PropsWithChildren } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

const managementNavigation = [
  { to: "/", label: "대시보드", end: true },
  { to: "/collect", label: "수집", end: false },
  { to: "/correct", label: "보정", end: false },
  { to: "/record-corrections", label: "기록정정", end: false },
  { to: "/database", label: "데이터베이스", end: false },
  { to: "/settings", label: "설정 및 진단", end: false },
] as const;

const analysisNavigation = [
  { to: "/analysis/models", label: "분석 모델 관리", end: false },
  { to: "/analysis/matchups", label: "투타 매치업", end: false },
  { to: "/analysis/pitcher-workload", label: "투수 운용", end: false },
  { to: "/analysis/baserunning", label: "주루와 추가 진루", end: false },
  { to: "/analysis/pitch-sequences", label: "배합과 궤적", end: false },
  { to: "/analysis/pitcher-changes", label: "투수 변화", end: false },
  { to: "/analysis/pitch-location", label: "투수 코스·결정구", end: false },
  { to: "/analysis/batter-profile", label: "타자 반응·성적", end: false },
  { to: "/analysis/statistics", label: "선수·팀 성적", end: false },
  { to: "/analysis/pitch-shape", label: "투구 움직임", end: false },
  { to: "/analysis/batter-discipline", label: "타자 선구안", end: false },
  { to: "/replay", label: "경기 재생", end: false },
  { to: "/analysis/coverage", label: "분석 자료 품질", end: false },
  { to: "/analysis/park-environment", label: "구장 득점 환경", end: false },
] as const;
type Workspace = "management" | "analysis";
function workspaceFor(path: string): Workspace {
  return path === "/analysis" || path.startsWith("/analysis/") || path === "/replay"
    ? "analysis"
    : "management";
}
function lastLocation(workspace: Workspace): string {
  const fallback = workspace === "analysis" ? "/analysis/pitch-shape" : "/";
  try {
    const value = sessionStorage.getItem(`kbo.workspace.${workspace}`);
    if (value === null || !value.startsWith("/") || value.startsWith("//")) return fallback;
    const path = value.split(/[?#]/u)[0] ?? "";
    const known = [...managementNavigation, ...analysisNavigation].some((item) => item.to === path);
    return known && workspaceFor(path) === workspace ? value : fallback;
  } catch {
    return fallback;
  }
}

export function AppShell({ children }: PropsWithChildren): React.JSX.Element {
  const location = useLocation();
  const workspace = workspaceFor(location.pathname);
  const navigation = workspace === "analysis" ? analysisNavigation : managementNavigation;
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [location.pathname]);
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
    <div className="app-shell">
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
          id="primary-navigation"
          className={menuOpen ? "sidebar open" : "sidebar"}
          aria-label="주 메뉴"
        >
          <span className="sidebar-section-label">
            {workspace === "analysis" ? "분석" : "데이터 관리"}
          </span>
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
