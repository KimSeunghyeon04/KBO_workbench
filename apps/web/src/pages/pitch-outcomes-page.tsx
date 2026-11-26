import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { Link } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import {
  BatterCountFlowQuerySchema,
  BatterProfileQuerySchema,
  PitchOutcomeQuerySchema,
  PitchCountFlowQuerySchema,
  type BatterCountFlowResponse,
  type BatterProfileResponse,
  type PitchAnalysisCatalog,
  type PitchCountFlowResponse,
  type PitchLocationResponse,
  type DisciplineCatalog,
} from "@kbo/contracts";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { TerminalBattingPanel } from "../analysis/terminal-batting-panel";
import { PitchOutcomeBreakdown } from "../analysis/pitch-rate-table";
import { WorkspaceTabs } from "../components/workspace-tabs";
import { PitchLocationMap } from "../analysis/pitch-location-panel";
import { AnalysisFilterBar } from "../analysis/analysis-filter-bar";
import { PitchOutcomeQuickFilters } from "../analysis/pitch-outcome-quick-filters";
import { outcomePercent } from "../analysis/pitch-outcome-presentation";
import { PlayerPeriodComparison } from "../analysis/player-period-comparison";
import { PitchArsenalPanel } from "../analysis/pitch-arsenal-panel";
import { PitchLocationPeriodComparison } from "../analysis/pitch-location-period-comparison";
import { SMALL_RATE_DENOMINATOR } from "../analysis/sample-rate";
import { sharedPitchSituationParams } from "../analysis/pitch-situation-params";
import { playerAnalysisHref } from "../analysis/player-analysis-navigation";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getPitchLocation, getBatterProfile } from "../api/pitch-outcomes-client";
import {
  getBatterCountFlow,
  getPitchCountFlow,
  isCountFlowUnavailable,
} from "../api/pitch-count-flow-client";
import { retryQuery } from "../api/query-retry";
import "../styles/pitch-analysis.css";
import "../styles/analysis-workspace.css";
import "../styles/pitch-location-comparison.css";

function catalogPlayers(catalog: PitchAnalysisCatalog | DisciplineCatalog) {
  return "pitchers" in catalog
    ? catalog.pitchers.map((p) => ({ id: p.pitcherId, name: p.name }))
    : catalog.batters.map((p) => ({ id: p.batterId, name: p.name }));
}

const outcomeTabsId = "pitch-outcomes";

export function PitchOutcomesPage({ role }: { role: "pitcher" | "batter" }) {
  const { params, season, scope, change, setParams } = useAnalysisScope();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const tabs = [
    { id: "overview", label: "코스·반응" },
    role === "pitcher"
      ? { id: "arsenal", label: "구종 배합" }
      : { id: "count-response", label: "카운트별 대응" },
    ...(role === "batter" ? ([{ id: "terminal", label: "타석 결과" }] as const) : []),
    { id: "period", label: "기간 비교" },
    { id: "sample", label: "표본 기준" },
  ] as const;
  const requestedCell = Number(params.get("locationCell")?.trim() || Number.NaN);
  const selectedCell =
    Number.isInteger(requestedCell) && requestedCell >= 0 && requestedCell < 25
      ? requestedCell
      : null;
  const activeTab =
    tabs.find((tab) => tab.id === params.get("outcomeView"))?.id ??
    (selectedCell !== null || params.get("periodCompare") !== "1" ? "overview" : "period");
  const isTerminalTab = activeTab === "terminal";
  function selectCell(cell: number | null) {
    const next = new URLSearchParams(params);
    if (cell === null) next.delete("locationCell");
    else next.set("locationCell", String(cell));
    next.set("outcomeView", "overview");
    setParams(next, { replace: true, preventScrollReset: true });
  }
  function switchTab(tab: (typeof tabs)[number]["id"], next = new URLSearchParams(params)) {
    if (tab === activeTab) return;
    next.set("outcomeView", tab);
    setParams(next);
    const workspace = workspaceRef.current;
    const tabList = workspace?.querySelector('[role="tablist"]');
    if (
      workspace &&
      tabList &&
      workspace.getBoundingClientRect().top < tabList.getBoundingClientRect().top
    )
      workspace.scrollIntoView({ block: "start" });
  }
  const commonCandidate = {
    season,
    ...scope.options,
    cohort: params.get("cohort") ?? "all",
  };
  const flowSchema = role === "batter" ? BatterCountFlowQuerySchema : PitchCountFlowQuerySchema;
  const outcomeSchema = role === "batter" ? BatterProfileQuerySchema : PitchOutcomeQuerySchema;
  const flowCandidate = {
    ...commonCandidate,
    include: "terminal-details" as const,
    ...(role === "batter" ? { split: "pitcher-hand" as const } : {}),
  };
  const candidate = {
    ...commonCandidate,
    ...(isTerminalTab
      ? { cohort: "all" }
      : {
          ...(params.has("balls") ? { balls: Number(params.get("balls")) } : {}),
          ...(params.has("strikes") ? { strikes: Number(params.get("strikes")) } : {}),
          ...(params.has("pitchType") ? { pitchType: params.get("pitchType") } : {}),
          ...(params.has("stance") ? { stance: params.get("stance") } : {}),
        }),
    ...(role === "batter" && params.has("pitcherHand")
      ? { pitcherHand: params.get("pitcherHand") }
      : {}),
  };
  const valid = scope.error === null && Value.Check(outcomeSchema, candidate);
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
  const canAnalyze = valid && id !== "";
  const isComparisonTab = activeTab === "period";
  const isFlowTab = activeTab === "arsenal" || activeTab === "count-response";
  const isOutcomeTab = !isComparisonTab && !isFlowTab;
  const flowTabLabel = role === "pitcher" ? "구종 배합" : "카운트별 대응";
  const linksToDiscipline =
    role === "batter" &&
    !isFlowTab &&
    !isTerminalTab &&
    params.get("pitchType") !== "" &&
    !params.has("pitcherHand");
  const flowValid = scope.error === null && Value.Check(flowSchema, flowCandidate);
  const activeValid = isFlowTab ? flowValid : valid;
  const analysis = useQuery<PitchLocationResponse | BatterProfileResponse>({
    queryKey: ["pitch-outcomes", role, id, candidate],
    meta: analysisQueryMeta(candidate),
    enabled: canAnalyze && isOutcomeTab,
    subscribed: isOutcomeTab,
    queryFn: ({ signal }) =>
      role === "pitcher"
        ? getPitchLocation(Value.Decode(PitchOutcomeQuerySchema, candidate), id, signal)
        : getBatterProfile(Value.Decode(BatterProfileQuerySchema, candidate), id, signal),
  });
  const flow = useQuery<PitchCountFlowResponse | BatterCountFlowResponse>({
    queryKey: ["pitch-count-flow", role, id, flowCandidate],
    meta: analysisQueryMeta(flowCandidate),
    enabled: isFlowTab && flowValid && id !== "",
    subscribed: isFlowTab,
    retry: (failures, error) => !isCountFlowUnavailable(error) && retryQuery(failures, error),
    refetchOnWindowFocus: (query) => !isCountFlowUnavailable(query.state.error),
    refetchOnReconnect: (query) => !isCountFlowUnavailable(query.state.error),
    queryFn: ({ signal }) => {
      if (!Value.Check(flowSchema, flowCandidate)) throw new Error("잘못된 카운트 전이 조건");
      return role === "pitcher"
        ? getPitchCountFlow(flowCandidate, id, signal)
        : getBatterCountFlow(flowCandidate, id, signal);
    },
  });
  const flowUnavailable = isFlowTab && isCountFlowUnavailable(flow.error);
  const flowData = flowUnavailable ? undefined : flow.data;
  const activeQueries = isFlowTab
    ? flowUnavailable
      ? [catalog]
      : [flow, catalog]
    : isOutcomeTab
      ? [analysis, catalog]
      : [catalog];
  const data = analysis.data;
  const conditions = [
    ...(!isFlowTab && params.has("balls") ? [`${params.get("balls")}볼`] : []),
    ...(!isFlowTab && params.has("strikes") ? [`${params.get("strikes")}스트라이크`] : []),
    ...(!isFlowTab && params.has("pitchType") ? [params.get("pitchType") || "구종 미상"] : []),
    ...(!isFlowTab && params.has("stance") ? [params.get("stance")] : []),
    ...(!isFlowTab && role === "batter" && params.has("pitcherHand")
      ? [params.get("pitcherHand") === "L" ? "좌완 상대" : "우완 상대"]
      : []),
    ...(params.get("cohort") === "discipline" ? ["선구안과 동일 상황"] : []),
  ].join(" · ");
  function relatedHref(path: string, filters: Record<string, string>) {
    const identity = params.get("player") ?? undefined;
    const href = playerAnalysisHref(path, role, id, season, scope.options, params, identity);
    const suffix = new URLSearchParams(filters).toString();
    return suffix ? `${href}&${suffix}` : href;
  }
  const selectedType = params.get("pitchType");
  function selectPitchType(key: string) {
    const type = key === "unknown" ? "" : key;
    const next = new URLSearchParams(params);
    if (selectedType === type) next.delete("pitchType");
    else next.set("pitchType", type);
    next.delete("locationCell");
    setParams(next, { preventScrollReset: true });
  }
  return (
    <div className="page-stack pitch-outcomes-page">
      <header className="page-header">
        <div>
          <h1>{role === "pitcher" ? "코스와 결정구" : "반응과 타석 결과"}</h1>
          <p>투구 위치와 타자의 반응을 한눈에 비교합니다.</p>
        </div>
      </header>
      {!isTerminalTab && (
        <AnalysisFilterBar
          collapsible={true}
          label="투구 결과 조건"
          toggleLabel="투구 조건"
          summary={conditions}
          advanced={
            <>
              {!isFlowTab && (
                <>
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
                      placeholder={params.has("pitchType") ? "구종 미상" : "전체"}
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
                  {role === "batter" && (
                    <label>
                      상대 투수
                      <select
                        value={params.get("pitcherHand") ?? ""}
                        onChange={(e) => change("pitcherHand", e.target.value)}
                      >
                        <option value="">전체</option>
                        <option value="L">좌완 상대</option>
                        <option value="R">우완 상대</option>
                      </select>
                    </label>
                  )}
                </>
              )}
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
        />
      )}
      <div className="outcome-workspace" ref={workspaceRef}>
        <div className="outcome-workspace-tabs">
          <WorkspaceTabs
            activeTab={activeTab}
            ariaLabel="세부 분석"
            idPrefix={outcomeTabsId}
            tabs={tabs}
            onChange={(tab) => switchTab(tab)}
          />
        </div>
        {!isFlowTab && !isTerminalTab && (
          <PitchOutcomeQuickFilters params={params} onChange={setParams} />
        )}
        {isTerminalTab && (
          <label className="outcome-terminal-filter">
            종결 투수 손
            <select
              value={params.get("pitcherHand") ?? ""}
              onChange={(e) => change("pitcherHand", e.target.value)}
            >
              <option value="">전체</option>
              <option value="L">좌완 상대</option>
              <option value="R">우완 상대</option>
            </select>
          </label>
        )}
        {!activeValid && <p role="alert">{scope.error ?? "투구 조건이 올바르지 않습니다."}</p>}
        <AnalysisQueryError queries={activeQueries} enabled={activeValid} />
        {catalog.isLoading ||
        (isFlowTab ? flow.isFetching : isOutcomeTab && analysis.isFetching) ? (
          <p role="status">분석 자료를 읽고 있습니다.</p>
        ) : null}
        {scope.error === null && players?.length === 0 && (
          <AnalysisEmptyState season={season} options={scope.options} />
        )}
        {catalog.isSuccess && id !== "" && !players?.some((p) => p.id === id) && (
          <p role="status">선택한 선수(ID {id})의 실제 투구가 이 조회 범위에 없습니다.</p>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="outcome-view"
            role="tabpanel"
            id={`${outcomeTabsId}-panel-${tab.id}`}
            aria-labelledby={`${outcomeTabsId}-tab-${tab.id}`}
            hidden={activeTab !== tab.id}
            tabIndex={0}
          >
            {activeTab === tab.id && tab.id === "overview" && data && (
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
                      {data.total.swings.toLocaleString()}스윙 중{" "}
                      {data.total.whiffs.toLocaleString()}
                      헛스윙
                    </span>
                    {data.total.swings > 0 && data.total.swings < SMALL_RATE_DENOMINATOR && (
                      <span>소표본 · 20스윙 미만</span>
                    )}
                  </div>
                  <div>
                    <dt>
                      루킹 + 헛스윙 <small>CSW%</small>
                    </dt>
                    <dd>{outcomePercent(data.total.cswRate)}</dd>
                    <span>실제 투구 중 {data.total.csw.toLocaleString()}구</span>
                    {data.total.pitches > 0 && data.total.pitches < SMALL_RATE_DENOMINATOR && (
                      <span>소표본 · 20구 미만</span>
                    )}
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
                    {data.total.twoStrikePitches > 0 &&
                      data.total.twoStrikePitches < SMALL_RATE_DENOMINATOR && (
                        <span>소표본 · 2S 공 20구 미만</span>
                      )}
                  </div>
                </dl>
                <div className="outcome-analysis-grid">
                  <PitchLocationMap
                    season={data.scope.season}
                    key={JSON.stringify([id, candidate, data.sourceHash])}
                    cells={data.cells}
                    points={data.points}
                    selectedCell={selectedCell}
                    onSelectCell={selectCell}
                  />
                  <PitchOutcomeBreakdown
                    key={role}
                    data={data}
                    onSelectType={selectPitchType}
                    selectedType={selectedType === "" ? "unknown" : selectedType}
                  />
                </div>
              </>
            )}
            {activeTab === tab.id && isFlowTab && flowUnavailable && (
              <div className="panel" role="alert">
                <p>이 서버에서 구종 전이 자료를 사용할 수 없습니다.</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!flowValid || flow.isFetching}
                  onClick={() => void flow.refetch()}
                >
                  {flowTabLabel} 다시 시도
                </button>
              </div>
            )}
            {activeTab === tab.id && isFlowTab && flowData && (
              <PitchArsenalPanel
                role={role}
                groups={flowData.groups}
                byPitcherHand={"byPitcherHand" in flowData ? flowData.byPitcherHand : undefined}
                onSelect={(group, pitchType) => {
                  const next = new URLSearchParams(params);
                  next.set(role, id);
                  if (pitchType === undefined) next.delete("pitchType");
                  else next.set("pitchType", pitchType ?? "");
                  const sideKey = role === "batter" ? "pitcherHand" : "stance";
                  if (role === "batter") next.delete("stance");
                  if (group.stance === "all") next.delete(sideKey);
                  else next.set(sideKey, group.stance);
                  next.set("balls", String(group.balls));
                  next.set("strikes", String(group.strikes));
                  next.delete("locationCell");
                  switchTab("overview", next);
                  workspaceRef.current
                    ?.querySelector<HTMLButtonElement>(`#${outcomeTabsId}-tab-overview`)
                    ?.focus({ preventScroll: true });
                }}
              />
            )}
            {activeTab === tab.id && tab.id === "period" && canAnalyze && role === "pitcher" && (
              <PitchLocationPeriodComparison
                query={candidate}
                id={id}
                params={params}
                onChange={setParams}
              />
            )}
            {activeTab === tab.id && tab.id === "period" && canAnalyze && role === "batter" && (
              <PlayerPeriodComparison
                kind="batter-profile"
                query={candidate}
                playerId={id}
                alwaysOpen
              />
            )}
            {activeTab === tab.id && tab.id === "terminal" && data && "batterId" in data && (
              <TerminalBattingPanel key={data.sourceHash} data={data.plateAppearances} />
            )}
            {activeTab === tab.id && tab.id === "sample" && data && (
              <section className="panel">
                <h2>표본과 계산 기준</h2>
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
                    <dt>좌표·존 미확인</dt>
                    <dd>{data.coverage.missingLocation.toLocaleString()}구</dd>
                  </div>
                  <div>
                    <dt>자동 삼진</dt>
                    <dd>{data.coverage.automaticStrikeouts.toLocaleString()}개</dd>
                  </div>
                </dl>
                <p className="analysis-caption">
                  Whiff%와 Contact%는 스윙, SwStr%·CSW%는 실제 투구가 분모입니다. 결정구%는
                  2스트라이크 실제 투구 중 삼진 종결 비율이며, 인플레이 안타 비율은 연결된 종결
                  인플레이 결과가 분모입니다. 분모가 없으면 —로 표시합니다.
                </p>
              </section>
            )}
          </div>
        ))}
        {(role === "pitcher" || linksToDiscipline) &&
          ((isFlowTab ? flowData : data) || (isComparisonTab && canAnalyze)) && (
            <section className="player-report-related" aria-label="구종·코스 심화 분석">
              {role === "pitcher" && (
                <Link
                  className="outcome-related-link"
                  to={relatedHref("/analysis/pitch-sequences", sharedPitchSituationParams(params))}
                >
                  {selectedType === null
                    ? "두 공의 배합·궤적"
                    : `두 번째 공이 ${selectedType || "구종 미상"}인 배합·궤적`}
                </Link>
              )}
              <Link
                className="outcome-related-link"
                to={
                  role === "pitcher"
                    ? relatedHref(
                        "/analysis/pitch-shape",
                        selectedType ? { type: selectedType } : {},
                      )
                    : relatedHref("/analysis/batter-discipline", sharedPitchSituationParams(params))
                }
              >
                {role === "pitcher" ? "같은 범위 구질 보기" : "조건 일치 선구안 비교"}{" "}
                <span aria-hidden="true">↗</span>
              </Link>
              {role === "batter" && (
                <p className="analysis-caption">
                  구종·카운트·타석 좌우 조건을 유지합니다. 선구안은 자체 상황 제외 기준을 적용하므로
                  실제 투구 전체 표본과 분모가 다를 수 있습니다.
                </p>
              )}
            </section>
          )}
      </div>
    </div>
  );
}
