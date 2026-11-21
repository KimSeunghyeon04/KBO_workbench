import { AnalysisSeasonOptions } from "./analysis-seasons";
import type { PropsWithChildren, ReactNode } from "react";
import type { PitchAnalysisCatalog } from "@kbo/contracts";
import { AnalysisScopeFields, analysisScopeSummary } from "./analysis-scope-fields";
import { AnalysisFilterBar } from "./analysis-filter-bar";
import type { AnalysisPlayerSelection } from "./analysis-scope";
export function PitcherScopeFields({
  season,
  params,
  pitchers,
  pitcherId,
  onChange,
  children,
  primary,
  summary,
  catalogLoaded = false,
}: PropsWithChildren<{
  season: number;
  params: URLSearchParams;
  pitchers: PitchAnalysisCatalog["pitchers"];
  pitcherId: string;
  onChange: (key: string, value: string, currentPlayers?: AnalysisPlayerSelection) => void;
  primary?: ReactNode;
  summary?: string;
  catalogLoaded?: boolean;
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
      <label>
        시즌
        <select
          value={season}
          onChange={(e) => onChange("season", e.target.value, { pitcher: pitcherId })}
        >
          <AnalysisSeasonOptions season={season} />
        </select>
      </label>
      <label>
        투수
        <select value={pitcherId} onChange={(e) => onChange("pitcher", e.target.value)}>
          {pitcherId !== "" && !pitchers.some((p) => p.pitcherId === pitcherId) && (
            <option value={pitcherId}>선택 투수 {pitcherId}</option>
          )}
          {pitchers.map((p) => (
            <option key={p.pitcherId} value={p.pitcherId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {primary}
      {catalogLoaded && pitcherId !== "" && !pitchers.some((p) => p.pitcherId === pitcherId) && (
        <p role="status">선택한 투수(ID {pitcherId})의 실제 투구가 이 조회 범위에 없습니다.</p>
      )}
    </AnalysisFilterBar>
  );
}
