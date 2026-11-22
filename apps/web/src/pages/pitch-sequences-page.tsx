import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { useQuery } from "@tanstack/react-query";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { Value } from "@sinclair/typebox/value";
import { PitchSequenceQuerySchema } from "@kbo/contracts";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { pitchSituationConditions, pitchSituationKeys } from "../analysis/pitch-situation-params";
import { PitchSequencePairs } from "../analysis/pitch-sequence-pairs";
import { pitcherCatalogQueryOptions } from "../api/analysis-catalog-query-options";
import { getPitchSequences } from "../api/pitch-sequence-client";
import "../styles/pitch-analysis.css";
import "../styles/pitch-sequence-filters.css";
export function PitchSequencesPage() {
  const { params, selected, season, scope, change, setParams } = useAnalysisScope();
  const query = {
    season,
    ...scope.options,
    ...(params.has("previousType") ? { previousType: params.get("previousType") } : {}),
    ...(params.has("pitchType") ? { pitchType: params.get("pitchType") } : {}),
    ...(params.has("balls") ? { balls: Number(params.get("balls")) } : {}),
    ...(params.has("strikes") ? { strikes: Number(params.get("strikes")) } : {}),
    ...(params.has("stance") ? { stance: params.get("stance") } : {}),
    cohort: params.get("cohort") ?? "all",
  };
  const valid = scope.error === null && Value.Check(PitchSequenceQuerySchema, query);
  const catalog = useQuery({
      ...pitcherCatalogQueryOptions(season, scope.options),
      enabled: scope.error === null,
    }),
    id = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "";
  const analysis = useQuery({
    queryKey: ["pitch-sequences", id, query],
    meta: analysisQueryMeta(query),
    enabled: valid && id !== "",
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchSequenceQuerySchema, query)) throw new Error("잘못된 배합 조건");
      return getPitchSequences(query, id, signal);
    },
  });
  const data = analysis.data;
  const conditions = [
    ...(params.has("previousType")
      ? [{ key: "previousType", label: `첫 구종: ${params.get("previousType")}` }]
      : []),
    ...pitchSituationConditions(params).map(({ key, label }) => ({
      key,
      label: ["pitchType", "balls", "strikes"].includes(key) ? `두 번째 ${label}` : label,
    })),
  ];
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>배합과 궤적 조합</h1>
          <p>같은 타석의 연속 두 실제 투구를 비교합니다.</p>
        </div>
      </header>
      <PitcherScopeFields
        params={selected}
        summary={[analysisScopeSummary(selected), ...conditions.map((c) => c.label)].join(" · ")}
        onChange={change}
      >
        <label>
          첫 구종
          <input
            value={params.get("previousType") ?? ""}
            onChange={(e) => change("previousType", e.target.value)}
            placeholder="전체"
          />
        </label>
        <label>
          다음 구종
          <input
            value={params.get("pitchType") ?? ""}
            onChange={(e) => change("pitchType", e.target.value)}
            placeholder="전체"
          />
        </label>
        <label>
          두 번째 볼
          <select
            value={params.get("balls") ?? ""}
            onChange={(e) => change("balls", e.target.value)}
          >
            <option value="">전체</option>
            {[0, 1, 2, 3].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          두 번째 스트라이크
          <select
            value={params.get("strikes") ?? ""}
            onChange={(e) => change("strikes", e.target.value)}
          >
            <option value="">전체</option>
            {[0, 1, 2].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          타석 좌우
          <select
            value={params.get("stance") ?? ""}
            onChange={(e) => change("stance", e.target.value)}
          >
            <option value="">전체</option>
            <option value="L">좌타자</option>
            <option value="R">우타자</option>
            <option value="S">스위치 타석</option>
          </select>
        </label>
        <label>
          표본
          <select
            value={params.get("cohort") ?? "all"}
            onChange={(e) => change("cohort", e.target.value)}
          >
            <option value="all">실제 투구 전체</option>
            <option value="discipline">선구안과 동일 상황</option>
          </select>
        </label>
      </PitcherScopeFields>
      <div className="pitch-sequence-conditions" role="group" aria-label="적용된 배합 조건">
        {conditions.length === 0 ? (
          <span>모든 배합 상황</span>
        ) : (
          conditions.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-label={`${label} 조건 해제`}
              onClick={() => change(key, "")}
            >
              {label} <span aria-hidden="true">×</span>
            </button>
          ))
        )}
        <button
          type="button"
          disabled={!["previousType", ...pitchSituationKeys].some((key) => params.has(key))}
          onClick={() => {
            const next = new URLSearchParams(params);
            for (const key of ["previousType", ...pitchSituationKeys]) next.delete(key);
            setParams(next);
          }}
        >
          배합 조건 초기화
        </button>
      </div>
      {!valid && <p role="alert">{scope.error ?? "배합 조건을 확인해 주세요."}</p>}
      <AnalysisQueryError queries={[analysis, catalog]} enabled={valid} />
      {analysis.isFetching && <p role="status">배합을 계산하고 있습니다.</p>}
      {catalog.data?.pitchers.length === 0 && <p>이 범위에 수집된 투수가 없습니다.</p>}
      {data && (
        <>
          <details className="analysis-caption">
            <summary>
              표본 구성 · 조건 일치 {data.coverage.filteredPairs}쌍 / 공통 면 계산 가능{" "}
              {data.coverage.geometryPairs}쌍
            </summary>
            <p>
              대상 실제 투구 {data.coverage.targetPitches}구 · 직전 공 없음{" "}
              {data.coverage.noPrevious} · 자동/비투구 경계 {data.coverage.nonActualBoundary} · 선수
              교체 {data.coverage.playerChange} · 연결 가능 {data.coverage.eligiblePairs}쌍 → 조건
              일치 {data.coverage.filteredPairs}쌍 → 공통 면 계산 가능 {data.coverage.geometryPairs}
              쌍.
            </p>
          </details>
          <PitchSequencePairs key={JSON.stringify([data.sourceHash, query, id])} data={data} />
        </>
      )}
    </div>
  );
}
