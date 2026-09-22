import type { PropsWithChildren } from "react";
import type { PitchAnalysisCatalog } from "@kbo/contracts";
import { AnalysisScopeFields } from "./analysis-scope-fields";
export function PitcherScopeFields({
  season,
  params,
  pitchers,
  pitcherId,
  onChange,
  children,
}: PropsWithChildren<{
  season: number;
  params: URLSearchParams;
  pitchers: PitchAnalysisCatalog["pitchers"];
  pitcherId: string;
  onChange: (key: string, value: string) => void;
}>) {
  return (
    <section className="panel pitch-analysis-toolbar">
      <label>
        시즌
        <select value={season} onChange={(e) => onChange("season", e.target.value)}>
          {[2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>
      <AnalysisScopeFields params={params} onChange={onChange} />
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
      {children}
    </section>
  );
}
