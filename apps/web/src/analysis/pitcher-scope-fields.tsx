import type { PropsWithChildren, ReactNode } from "react";
import { AnalysisScopeFields, analysisScopeSummary } from "./analysis-scope-fields";
import { AnalysisFilterBar } from "./analysis-filter-bar";
export function PitcherScopeFields({
  params,
  onChange,
  children,
  primary,
  summary,
}: PropsWithChildren<{
  params: URLSearchParams;
  onChange: (key: string, value: string) => void;
  primary?: ReactNode;
  summary?: string;
}>) {
  return (
    <AnalysisFilterBar
      label="투수 분석 조건"
      collapsible={primary === undefined}
      summary={summary ?? analysisScopeSummary(params)}
      advanced={
        <>
          <AnalysisScopeFields params={params} onChange={onChange} />
          {children}
        </>
      }
    >
      {primary}
    </AnalysisFilterBar>
  );
}
