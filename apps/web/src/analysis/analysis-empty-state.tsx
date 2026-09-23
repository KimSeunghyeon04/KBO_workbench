import type { AnalysisScopeOptions } from "@kbo/contracts";
import { Link } from "react-router-dom";
import { analysisScopeSearch } from "./analysis-scope";

export function AnalysisEmptyState({
  season,
  options,
}: {
  season: number;
  options: AnalysisScopeOptions;
}) {
  return (
    <section className="panel analysis-empty-state" role="status">
      <h2>선택한 범위에 분석할 선수가 없습니다</h2>
      <p>
        기간을 넓히거나 경기 종류를 변경해 보세요. 자료 품질에서 수집 범위를 확인할 수 있습니다.
      </p>
      <Link className="text-link" to={`/analysis/coverage?${analysisScopeSearch(season, options)}`}>
        이 범위의 자료 품질 확인 →
      </Link>
    </section>
  );
}
