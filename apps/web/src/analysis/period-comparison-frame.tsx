import { useAnalysisSeasons } from "./analysis-seasons";
import { useState, type ReactNode } from "react";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisScopeQuerySchema,
  canonicalStringify,
  analysisPeriodQueries,
  type AnalysisScopeQuery,
  type AnalysisPeriodQuery,
} from "@kbo/contracts";
import "../styles/pitch-location-comparison.css";
import { periodUrlKeys } from "./period-selection";

interface PeriodInput {
  season: string;
  from: string;
  to: string;
}
interface Periods {
  a: PeriodInput;
  b: PeriodInput;
}
export function periodComparisonKey(query: AnalysisScopeQuery, params: URLSearchParams) {
  return canonicalStringify([query, ...periodUrlKeys.map((key) => params.get(key))]);
}
const queryOf = (base: AnalysisScopeQuery, p: Periods): AnalysisPeriodQuery => ({
  season: Number(p.a.season),
  ...(base.competition === undefined ? {} : { competition: base.competition }),
  ...(p.a.from === "" ? {} : { dateFrom: p.a.from }),
  ...(p.a.to === "" ? {} : { dateTo: p.a.to }),
  compareSeason: Number(p.b.season),
  ...(p.b.from === "" ? {} : { compareDateFrom: p.b.from }),
  ...(p.b.to === "" ? {} : { compareDateTo: p.b.to }),
});
export function PeriodComparisonFrame({
  query,
  params,
  onChange,
  title,
  description,
  children,
  alwaysOpen = false,
  dateFocused = false,
}: {
  query: AnalysisScopeQuery;
  params: URLSearchParams;
  onChange: (next: URLSearchParams) => void;
  title: string;
  description: string;
  children: (periods: AnalysisPeriodQuery) => ReactNode;
  alwaysOpen?: boolean;
  dateFocused?: boolean;
}) {
  const seasonSchema = AnalysisScopeQuerySchema.properties.season;
  const priorSeason = query.season - 1;
  const hasAppliedComparison = params.get("periodCompare") === "1";
  const firstSeason =
    (dateFocused && !hasAppliedComparison) || !Value.Check(seasonSchema, priorSeason)
      ? query.season
      : priorSeason;
  const initial: Periods = {
    a: {
      season: params.get("periodASeason") ?? String(firstSeason),
      from: params.get("periodAFrom") ?? "",
      to: params.get("periodATo") ?? "",
    },
    b: {
      season: params.get("periodBSeason") ?? String(query.season),
      from: params.get("periodBFrom") ?? query.dateFrom ?? "",
      to: params.get("periodBTo") ?? query.dateTo ?? "",
    },
  };
  const [expanded, setExpanded] = useState(hasAppliedComparison);
  const open = alwaysOpen || expanded;
  const [draft, setDraft] = useState(initial);
  const applied = hasAppliedComparison ? initial : null;
  const [submitted, setSubmitted] = useState(false);
  const request = queryOf(query, draft);
  let error: string | null = null;
  try {
    analysisPeriodQueries(request);
  } catch (e) {
    error = e instanceof Error ? e.message : "기간을 확인하세요.";
  }
  const dirty = applied === null || canonicalStringify(applied) !== canonicalStringify(draft);
  const change = (key: "a" | "b", field: keyof PeriodInput, value: string) =>
    setDraft((current) => ({
      ...current,
      [key]: {
        ...current[key],
        [field]: value,
        ...(field === "season" ? { from: "", to: "" } : {}),
      },
    }));
  const availableSeasons = useAnalysisSeasons();
  const years = [
    ...new Set([
      ...(availableSeasons.data?.seasons ?? []),
      query.season,
      Number(draft.a.season),
      Number(draft.b.season),
    ]),
  ]
    .filter((year) => Value.Check(seasonSchema, year))
    .sort((a, b) => a - b);
  return (
    <section
      className={`panel location-period-comparison${dateFocused && !open ? " location-period-comparison-collapsed" : ""}`}
      aria-label={title}
    >
      <div className="analysis-panel-heading">
        <h2>{title}</h2>
        {!alwaysOpen && (
          <button
            type="button"
            className="secondary-button"
            aria-expanded={open}
            onClick={() => setExpanded(!expanded)}
          >
            {open ? "기간 비교 접기" : "기간 비교 열기"}
          </button>
        )}
      </div>
      {(open || !dateFocused) && (
        <p className="analysis-caption">
          {description} 날짜를 비우면 해당 시즌 전체입니다. 차이는 B−A입니다.
        </p>
      )}
      {open && (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (error !== null) return;
              const next = new URLSearchParams(params);
              next.set("periodCompare", "1");
              for (const [key, p] of [
                ["A", draft.a],
                ["B", draft.b],
              ] as const)
                for (const [field, value] of [
                  ["Season", p.season],
                  ["From", p.from],
                  ["To", p.to],
                ] as const)
                  next.set(`period${key}${field}`, value);
              onChange(next);
            }}
          >
            <div className="location-period-fields">
              {(["a", "b"] as const).map((key) => (
                <fieldset key={key}>
                  <legend>기간 {key.toUpperCase()}</legend>
                  <label>
                    시즌
                    <select
                      aria-label={`기간 ${key.toUpperCase()} 시즌`}
                      value={draft[key].season}
                      onChange={(e) => change(key, "season", e.target.value)}
                    >
                      {years.map((year) => (
                        <option key={year} value={year}>
                          {year}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    시작일
                    <input
                      type="date"
                      aria-label={`기간 ${key.toUpperCase()} 시작일`}
                      value={draft[key].from}
                      min={`${draft[key].season}-01-01`}
                      max={`${draft[key].season}-12-31`}
                      onChange={(e) => change(key, "from", e.target.value)}
                    />
                  </label>
                  <label>
                    종료일
                    <input
                      type="date"
                      aria-label={`기간 ${key.toUpperCase()} 종료일`}
                      value={draft[key].to}
                      min={`${draft[key].season}-01-01`}
                      max={`${draft[key].season}-12-31`}
                      onChange={(e) => change(key, "to", e.target.value)}
                    />
                  </label>
                </fieldset>
              ))}
            </div>
            {error !== null && (submitted || applied !== null) && <p role="alert">{error}</p>}
            <button type="submit" className="analysis-button">
              두 기간 비교 적용
            </button>
            {dirty && applied !== null && (
              <p className="analysis-caption" role="status">
                기간을 변경했습니다. 비교 적용 후 새 결과를 표시합니다.
              </p>
            )}
          </form>
          {applied !== null && !dirty && error === null && children(request)}
        </>
      )}
    </section>
  );
}
