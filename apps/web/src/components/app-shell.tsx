import type { PropsWithChildren } from "react";
import { NavLink } from "react-router-dom";

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
  return (
    <div className="app-shell">
      <header className="topbar">
        <strong className="brand-name">KBO Workbench</strong>
        <span className="environment-label">로컬</span>
      </header>
      <div className="body-grid">
        <nav className="sidebar" aria-label="주 메뉴">
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
