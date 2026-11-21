import { useAnalysisSeason } from "./analysis-seasons";
import { useSearchParams } from "react-router-dom";
import {
  changeAnalysisParams,
  scopeFromParams,
  type AnalysisPlayerSelection,
} from "./analysis-scope";

// These analyses share the regular-season default. Legacy shape/discipline pages keep
// their all-games default and their own season/selection rules.
export function useAnalysisScope({
  throughSeasonEnd = false,
}: {
  throughSeasonEnd?: boolean;
} = {}) {
  const [params, setParams] = useSearchParams();
  const season = useAnalysisSeason(params.get("season"));
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  if (throughSeasonEnd && !selected.has("dateTo")) selected.set("dateTo", `${season}-12-31`);
  const scope = scopeFromParams(season, selected);

  function change(key: string, value: string, currentPlayers?: AnalysisPlayerSelection): void {
    setParams(changeAnalysisParams(params, key, value, currentPlayers));
  }

  return { params, selected, season, scope, change, setParams };
}
