import { useEffect, useState, type PropsWithChildren } from "react";
import { NavLink, useLocation } from "react-router-dom";

const navigation = [
  { to: "/", label: "대시보드", end: true },
  { to: "/collect", label: "수집", end: false },
  { to: "/correct", label: "보정", end: false },
  { to: "/record-corrections", label: "기록정정", end: false },
  { to: "/database", label: "데이터베이스", end: false },
  { to: "/replay", label: "경기 재생", end: false },
  { to: "/settings", label: "설정 및 진단", end: false },
] as const;

export function AppShell({ children }: PropsWithChildren): React.JSX.Element {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <strong className="brand-name">KBO Workbench</strong>
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
