import { AnalysisScopeFields, analysisScopeSummary } from "./analysis-scope-fields";
import "../styles/player-basic-statistics.css";

export function PlayerRecordConditions({
  params,
  invalid,
  season,
  change,
}: {
  params: URLSearchParams;
  invalid: boolean;
  season?: number;
  change: (key: string, value: string) => void;
}) {
  return (
    <details className="panel player-report-filters player-analysis-scope-editor">
      <summary>
        <strong>경기 종류·기간</strong>{" "}
        <span className="player-analysis-scope-summary">
          {invalid ? "조회 범위 확인 필요" : analysisScopeSummary(params)}
        </span>
      </summary>
      <div className="player-report-filter-fields">
        <AnalysisScopeFields params={params} onChange={change} />
      </div>
      {season !== undefined && (
        <p className="analysis-caption">
          날짜를 지정하면 {season}년의 해당 기간 기록을 표시합니다.
        </p>
      )}
    </details>
  );
}
