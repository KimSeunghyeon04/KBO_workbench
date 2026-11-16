import type { PropsWithChildren } from "react";
import { Link, useLocation } from "react-router-dom";
import { playerAnalysisSections } from "./player-analysis-navigation";

// Keep the return journey in browser history, separate from sealed replay identity.
export function AnalysisEvidenceLink({ to, children }: PropsWithChildren<{ readonly to: string }>) {
  const { pathname, search, hash } = useLocation();
  return (
    <Link to={to} state={{ analysisReturnTo: `${pathname}${search}${hash}` }}>
      {children}
    </Link>
  );
}

export function readAnalysisReturnTo(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("analysisReturnTo" in state)) return null;
  const to = state.analysisReturnTo;
  if (
    typeof to !== "string" ||
    to.includes("\\") ||
    [...to].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const path = to.split(/[?#]/, 1)[0];
  const supported =
    path === "/analysis/baserunning" ||
    [...playerAnalysisSections.pitcher, ...playerAnalysisSections.batter].some(
      (section) => section.path === path,
    );
  return supported ? to : null;
}
