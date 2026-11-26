import { AnalysisScopeFields, analysisScopeSummary } from "./analysis-scope-fields";
import "../styles/player-basic-statistics.css";

export function PlayerRecordConditions({
  selected,
  season,
  change,
}: {
  selected: URLSearchParams;
  season: number;
  change: (key: string, value: string) => void;
}) {
  return (
    <details className="panel player-report-filters" aria-label="조회 조건">
      <summary>
        <strong>조회 조건 변경</strong>
      </summary>
      <div className="player-report-filter-fields">
        <AnalysisScopeFields params={selected} onChange={change} />
      </div>
      <p className="analysis-caption">
        {season} · {analysisScopeSummary(selected)}
      </p>
    </details>
  );
}
