import {
  AnalysisScopeQuerySchema,
  resolveAnalysisScope,
  type AnalysisScopeOptions,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

export const competitionLabels = {
  all: "수집 경기 전체",
  regular: "확인된 정규시즌",
  preseason: "시범경기",
  postseason: "포스트시즌",
  unknown: "경기 종류 미상",
};
export function scopeFromParams(
  season: number,
  params: URLSearchParams,
): { options: AnalysisScopeOptions; error: string | null } {
  const candidate = {
    season,
    ...Object.fromEntries(
      ["competition", "dateFrom", "dateTo"].flatMap((key) => {
        const value = params.get(key);
        return value === null || value === "" ? [] : [[key, value]];
      }),
    ),
  };
  if (!Value.Check(AnalysisScopeQuerySchema, candidate))
    return { options: {}, error: "분석 범위가 올바르지 않습니다." };
  try {
    resolveAnalysisScope(candidate);
  } catch (error) {
    return { options: {}, error: error instanceof Error ? error.message : "잘못된 분석 범위" };
  }
  const { season: unused, ...options } = candidate;
  void unused;
  return { options, error: null };
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
          value={params.get("competition") ?? "all"}
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
