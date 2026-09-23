export const competitionLabels = {
  all: "수집 경기 전체",
  regular: "확인된 정규시즌",
  preseason: "시범경기",
  postseason: "포스트시즌",
  unknown: "경기 종류 미상",
};

export function analysisScopeSummary(params: URLSearchParams): string {
  const competition =
    Object.entries(competitionLabels).find(
      ([key]) => key === (params.get("competition") ?? "all"),
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
