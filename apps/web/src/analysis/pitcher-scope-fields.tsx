import type { PropsWithChildren, ReactNode } from "react";
import type { PitchAnalysisCatalog } from "@kbo/contracts";
import { AnalysisScopeFields, analysisScopeSummary } from "./analysis-scope-fields";
import { AnalysisFilterBar } from "./analysis-filter-bar";
export function PitcherScopeFields({
  season,
  params,
  pitchers,
  pitcherId,
  onChange,
  children,
  primary,
}: PropsWithChildren<{
  season: number;
  params: URLSearchParams;
  pitchers: PitchAnalysisCatalog["pitchers"];
  pitcherId: string;
  onChange: (key: string, value: string) => void;
  primary?: ReactNode;
}>) {
  return (
    <AnalysisFilterBar
      label="투수 분석 조건"
      summary={analysisScopeSummary(params)}
      advanced={
        <>
          <AnalysisScopeFields params={params} onChange={onChange} />
          {children}
        </>
      }
    >
      <label>
        시즌
        <select value={season} onChange={(e) => onChange("season", e.target.value)}>
          {[2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>
      <label>
        투수
        <select value={pitcherId} onChange={(e) => onChange("pitcher", e.target.value)}>
          {pitchers.map((p) => (
            <option key={p.pitcherId} value={p.pitcherId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {primary}
    </AnalysisFilterBar>
  );
}
