import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import {
  PitchOutcomeQuerySchema,
  type PitchAnalysisCatalog,
  type DisciplineCatalog,
} from "@kbo/contracts";
import { AnalysisScopeFields, analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { TerminalBattingPanel } from "../analysis/terminal-batting-panel";
import { PitchRateTable, PitchOutcomeBreakdown } from "../analysis/pitch-rate-table";
import { PitchLocationMap } from "../analysis/pitch-location-panel";
import { AnalysisFilterBar } from "../analysis/analysis-filter-bar";
import { PitchOutcomeQuickFilters } from "../analysis/pitch-outcome-quick-filters";
import { outcomePercent } from "../analysis/pitch-outcome-presentation";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getPitchLocation, getBatterProfile } from "../api/pitch-outcomes-client";
import "../styles/pitch-analysis.css";
import "../styles/analysis-workspace.css";

function catalogPlayers(catalog: PitchAnalysisCatalog | DisciplineCatalog) {
  return "pitchers" in catalog
    ? catalog.pitchers.map((p) => ({ id: p.pitcherId, name: p.name }))
    : catalog.batters.map((p) => ({ id: p.batterId, name: p.name }));
}

export function PitchOutcomesPage({ role }: { role: "pitcher" | "batter" }) {
  const { params, selected, season, scope, change, setParams } = useAnalysisScope({
    seasonSelectionKeys: [role],
  });
  const candidate = {
    season,
    ...scope.options,
    ...(params.has("balls") ? { balls: Number(params.get("balls")) } : {}),
    ...(params.has("strikes") ? { strikes: Number(params.get("strikes")) } : {}),
    ...(params.has("pitchType") ? { pitchType: params.get("pitchType") } : {}),
    ...(params.has("stance") ? { stance: params.get("stance") } : {}),
    cohort: params.get("cohort") ?? "all",
  };
  const valid = scope.error === null && Value.Check(PitchOutcomeQuerySchema, candidate);
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof catalogPlayers>
  >({
    ...(role === "pitcher"
      ? pitcherCatalogQueryOptions(season, scope.options)
      : batterCatalogQueryOptions(season, scope.options)),
    enabled: scope.error === null,
    select: catalogPlayers,
  });
  const players = catalog.data;
  const id = params.get(role) ?? players?.[0]?.id ?? "";
  const analysis = useQuery({
    queryKey: ["pitch-outcomes", role, id, candidate],
    enabled: valid && id !== "",
    queryFn: async ({ signal }) => {
      if (!Value.Check(PitchOutcomeQuerySchema, candidate)) throw new Error("잘못된 투구 조건");
      return role === "pitcher"
        ? getPitchLocation(candidate, id, signal)
        : getBatterProfile(candidate, id, signal);
    },
  });
  const data = analysis.data;
  const conditions = [
    analysisScopeSummary(selected),
    ...(params.has("balls") ? [`${params.get("balls")}볼`] : []),
    ...(params.has("strikes") ? [`${params.get("strikes")}스트라이크`] : []),
    ...(params.has("pitchType") ? [params.get("pitchType")] : []),
    ...(params.has("stance") ? [params.get("stance")] : []),
    ...(params.get("cohort") === "discipline" ? ["선구안과 동일 상황"] : []),
  ].join(" · ");
  return (
    <div className="page-stack pitch-outcomes-page">
      <header className="page-header">
        <div>
          <h1>{role === "pitcher" ? "코스와 결정구" : "반응과 종결 성적"}</h1>
          <p>투구 위치와 타자의 반응을 한눈에 비교합니다.</p>
        </div>
      </header>
      <AnalysisFilterBar
        label="투구 결과 조건"
        summary={conditions}
        advanced={
          <>
            <AnalysisScopeFields params={selected} onChange={change} />
            <label>
              볼
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
              스트라이크
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
              구종
              <input
                value={params.get("pitchType") ?? ""}
                onChange={(e) => change("pitchType", e.target.value)}
                placeholder="전체"
              />
            </label>
            <label>
              타석 좌우
              <select
                value={params.get("stance") ?? ""}
                onChange={(e) => change("stance", e.target.value)}
              >
                <option value="">전체</option>
                {["L", "R", "S"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
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
          </>
        }
      >
        <label>
          시즌
          <select
            aria-label="투구 결과 시즌"
            value={season}
            onChange={(e) => change("season", e.target.value)}
          >
            {[2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
        <label>
          {role === "pitcher" ? "투수" : "타자"}
          <select aria-label="분석 선수" value={id} onChange={(e) => change(role, e.target.value)}>
            {players?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </AnalysisFilterBar>
      <PitchOutcomeQuickFilters params={params} onChange={setParams} />
      {!valid && <p role="alert">{scope.error ?? "투구 조건이 올바르지 않습니다."}</p>}
      {(analysis.error || catalog.error) && (
        <p role="alert">{String(analysis.error ?? catalog.error)}</p>
      )}
      {catalog.isLoading || analysis.isFetching ? (
        <p role="status">분석 자료를 읽고 있습니다.</p>
      ) : null}
      {scope.error === null && players?.length === 0 && (
        <AnalysisEmptyState season={season} options={scope.options} />
      )}
      {data && (
        <>
          <dl className="outcome-metrics" aria-label="핵심 투구 지표">
            <div>
              <dt>분석 투구</dt>
              <dd>
                {data.total.pitches.toLocaleString()}
                <small>구</small>
              </dd>
              <span>선택한 조건의 실제 투구</span>
            </div>
            <div>
              <dt>
                헛스윙률 <small>Whiff%</small>
              </dt>
              <dd>{outcomePercent(data.total.whiffRate)}</dd>
              <span>
                {data.total.swings.toLocaleString()}스윙 중 {data.total.whiffs.toLocaleString()}
                헛스윙
              </span>
            </div>
            <div>
              <dt>
                루킹 + 헛스윙 <small>CSW%</small>
              </dt>
              <dd>{outcomePercent(data.total.cswRate)}</dd>
              <span>실제 투구 중 {data.total.csw.toLocaleString()}구</span>
            </div>
            <div>
              <dt>
                결정구 <small>PutAway%</small>
              </dt>
              <dd>{outcomePercent(data.total.putAwayRate)}</dd>
              <span>
                2S {data.total.twoStrikePitches.toLocaleString()}구 중{" "}
                {data.total.terminalStrikeouts.toLocaleString()}삼진
              </span>
            </div>
          </dl>
          <div className="outcome-analysis-grid">
            <PitchOutcomeBreakdown key={role} data={data} />
            <PitchLocationMap
              key={JSON.stringify([id, candidate, data.sourceHash])}
              cells={data.cells}
              points={data.points}
            />
          </div>
          {"batterId" in data && (
            <TerminalBattingPanel key={data.sourceHash} data={data.plateAppearances} />
          )}
          <details className="panel analysis-disclosure">
            <summary>전체 반응 지표</summary>
            <PitchRateTable title="전체 반응" rows={[data.total]} />
          </details>
          <details className="panel analysis-disclosure">
            <summary>
              표본과 계산 기준{" "}
              <span>좌표·존 미확인 {data.coverage.missingLocation.toLocaleString()}구</span>
            </summary>
            <dl className="outcome-coverage-list">
              <div>
                <dt>기간 내 투구</dt>
                <dd>{data.coverage.scopePitches.toLocaleString()}구</dd>
              </div>
              <div>
                <dt>조건 일치</dt>
                <dd>{data.coverage.filteredPitches.toLocaleString()}구</dd>
              </div>
              <div>
                <dt>상황 제외</dt>
                <dd>{data.coverage.excludedSituations.toLocaleString()}구</dd>
              </div>
              <div>
                <dt>반응 분석</dt>
                <dd>{data.total.pitches.toLocaleString()}구</dd>
              </div>
              <div>
                <dt>지도에 표시</dt>
                <dd>{data.coverage.locationPitches.toLocaleString()}구</dd>
              </div>
              <div>
                <dt>자동 삼진</dt>
                <dd>{data.coverage.automaticStrikeouts.toLocaleString()}개</dd>
              </div>
            </dl>
            <p className="analysis-caption">
              Whiff%와 Contact%는 스윙, SwStr%·CSW%는 실제 투구가 분모입니다. 결정구%는 2스트라이크
              실제 투구 중 삼진 종결 비율이며, 인플레이 안타 비율은 연결된 종결 인플레이 결과가
              분모입니다. 분모가 없으면 —로 표시합니다.
            </p>
          </details>
          <Link
            className="outcome-related-link"
            to={`/analysis/${role === "pitcher" ? "pitch-shape" : "batter-discipline"}?${new URLSearchParams({ season: String(season), ...scope.options, [role]: id })}`}
          >
            {role === "pitcher" ? "같은 범위 구질 보기" : "조건 일치 선구안 비교"}{" "}
            <span aria-hidden="true">↗</span>
          </Link>
        </>
      )}
    </div>
  );
}
