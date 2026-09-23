import { useSearchParams } from "react-router-dom";
import { changeAnalysisParams, scopeFromParams } from "./analysis-scope";

// These analyses share the regular-season default. Legacy shape/discipline pages keep
// their all-games default and their own season/selection rules.
export function useAnalysisScope({
  seasonSelectionKeys = [],
  throughSeasonEnd = false,
}: {
  seasonSelectionKeys?: readonly ("pitcher" | "batter")[];
  throughSeasonEnd?: boolean;
} = {}) {
  const [params, setParams] = useSearchParams();
  const season = Number(params.get("season") ?? 2025);
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  if (throughSeasonEnd && !selected.has("dateTo")) selected.set("dateTo", `${season}-12-31`);
  const scope = scopeFromParams(season, selected);

  function change(key: string, value: string): void {
    setParams(changeAnalysisParams(params, key, value, seasonSelectionKeys));
  }

  return { params, selected, season, scope, change, setParams };
}
