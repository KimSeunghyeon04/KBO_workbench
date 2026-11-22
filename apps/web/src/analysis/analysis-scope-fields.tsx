import { defaultAnalysisCompetition, type AnalysisScope } from "@kbo/contracts";
import { selectedAnalysisCompetition } from "./analysis-scope";

export const competitionLabels = {
  regular: "정규시즌",
  postseason: "포스트시즌",
  allstar: "올스타전",
  preseason: "시범경기",
  unknown: "경기 종류 미상",
} satisfies Record<AnalysisScope["competition"], string>;

export function analysisScopeSummary(params: URLSearchParams): string {
  const competition =
    Object.entries(competitionLabels).find(
      ([key]) => key === (selectedAnalysisCompetition(params) ?? defaultAnalysisCompetition),
    )?.[1] ?? "경기 종류 미상";
  const period =
    params.has("dateFrom") || params.has("dateTo")
      ? `${params.get("dateFrom") ?? "시즌 시작"} ~ ${params.get("dateTo") ?? "시즌 끝"}`
      : "시즌 전체";
  return `${competition} · ${period}`;
}
export function AnalysisScopeFields({
  params,
  onChange,
}: {
  params: URLSearchParams;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      <label>
        경기 종류
        <select
          aria-label="경기 종류"
          value={selectedAnalysisCompetition(params) ?? defaultAnalysisCompetition}
          onChange={(event) => onChange("competition", event.target.value)}
        >
          {Object.entries(competitionLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        시작일
        <input
          aria-label="분석 시작일"
          type="date"
          value={params.get("dateFrom") ?? ""}
          onChange={(event) => onChange("dateFrom", event.target.value)}
        />
      </label>
      <label>
        종료일
        <input
          aria-label="분석 종료일"
          type="date"
          value={params.get("dateTo") ?? ""}
          onChange={(event) => onChange("dateTo", event.target.value)}
        />
      </label>
    </>
  );
}
