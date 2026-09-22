import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { PitchSequenceQuerySchema } from "@kbo/contracts";
import { scopeFromParams } from "../analysis/analysis-scope-fields";
import { PitcherScopeFields } from "../analysis/pitcher-scope-fields";
import { PitchSequencePairs } from "../analysis/pitch-sequence-pairs";
import { getPitchAnalysisCatalog } from "../api/pitch-analysis-client";
import { getPitchSequences } from "../api/pitch-sequence-client";
import "../styles/pitch-analysis.css";
export function PitchSequencesPage() {
  const [params, setParams] = useSearchParams(),
    selected = new URLSearchParams(params),
    season = Number(params.get("season") ?? 2025);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected),
    query = {
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
      queryKey: ["sequence-catalog", season, scope.options],
      enabled: scope.error === null,
      queryFn: ({ signal }) => getPitchAnalysisCatalog(season, signal, scope.options),
    }),
    id = params.get("pitcher") ?? catalog.data?.pitchers[0]?.pitcherId ?? "";
  const analysis = useQuery({
    queryKey: ["pitch-sequences", id, query],
    enabled: valid && id !== "",
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchSequenceQuerySchema, query)) throw new Error("잘못된 배합 조건");
      return getPitchSequences(query, id, signal);
    },
  });
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "season") {
      next.delete("dateFrom");
      next.delete("dateTo");
      next.delete("pitcher");
    }
    setParams(next);
  }
  const data = analysis.data;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>배합과 궤적 조합</h1>
          <p>같은 타석의 연속 두 실제 투구를 비교합니다.</p>
        </div>
      </header>
      <PitcherScopeFields
        season={season}
        params={selected}
        pitchers={catalog.data?.pitchers ?? []}
        pitcherId={id}
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
      </PitcherScopeFields>
      {!valid && <p role="alert">{scope.error ?? "배합 조건을 확인해 주세요."}</p>}
      {(analysis.error || catalog.error) && (
        <p role="alert">{String(analysis.error ?? catalog.error)}</p>
      )}
      {analysis.isFetching && <p role="status">배합을 계산하고 있습니다.</p>}
      {catalog.data?.pitchers.length === 0 && <p>이 범위에 수집된 투수가 없습니다.</p>}
      {data && (
        <>
          <section className="panel">
            <p>
              대상 실제 투구 {data.coverage.targetPitches}구 · 직전 공 없음{" "}
              {data.coverage.noPrevious} · 자동/비투구 경계 {data.coverage.nonActualBoundary} · 선수
              교체 {data.coverage.playerChange} · 연결 가능 {data.coverage.eligiblePairs}쌍 → 조건
              일치 {data.coverage.filteredPairs}쌍 → 공통 면 계산 가능 {data.coverage.geometryPairs}
              쌍.
            </p>
          </section>
          <PitchSequencePairs key={JSON.stringify([data.sourceHash, query, id])} data={data} />
        </>
      )}
    </div>
  );
}
