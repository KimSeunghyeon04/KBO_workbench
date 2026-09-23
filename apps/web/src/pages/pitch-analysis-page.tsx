import { PitchQualityPanel } from "../analysis/pitch-quality-panel";
import { PitchAnglesPanel } from "../analysis/pitch-angles-panel";
import { PitchProfilePanel } from "../analysis/pitch-profile-panel";
import { canonicalStringify, resolveAnalysisScope } from "@kbo/contracts";
import { AnalysisScopeFields, analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { AnalysisFilterBar } from "../analysis/analysis-filter-bar";
import { scopeFromParams } from "../analysis/analysis-scope";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { PitchAnalysisPoint } from "@kbo/contracts";

import { getPitchAnalysis } from "../api/pitch-analysis-client";
import { pitcherCatalogQueryOptions } from "../api/analysis-catalog-query-options";
import { PitchShapeChart, signed } from "../analysis/pitch-shape-chart";
import { PitchExpectationPanel, referenceBandLabel } from "../analysis/pitch-expectation-panel";
import { groupLabel, pointColor, type ColorMode } from "../analysis/pitch-presentation";
import "../styles/pitch-analysis.css";

const pitchKey = (point: PitchAnalysisPoint): string =>
  JSON.stringify([point.gameId, point.revision, point.pitchId, point.trackingId]);

export function PitchAnalysisPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const requestedSeason = Number(params.get("season"));
  const season =
    Number.isInteger(requestedSeason) && requestedSeason >= 2020 && requestedSeason <= 2025
      ? requestedSeason
      : 2025;
  const scope = scopeFromParams(season, params);
  const catalog = useQuery({
    ...pitcherCatalogQueryOptions(season, scope.options),
    enabled: scope.error === null,
  });
  const requestedPitcher = params.get("pitcher") ?? "";
  const pitcher =
    catalog.data?.pitchers.find((item) => item.pitcherId === requestedPitcher) ??
    catalog.data?.pitchers[0];
  const pitcherId = pitcher?.pitcherId ?? "";
  const countParam = params.get("clusterCount");
  const requestedCount = countParam === null ? undefined : Number(countParam);
  const invalidCount =
    requestedCount !== undefined &&
    (!/^[1-9]\d*$/.test(countParam ?? "") || !Number.isSafeInteger(requestedCount));
  const analysis = useQuery({
    queryKey: ["pitch-analysis", season, pitcherId, countParam ?? "default", scope.options],
    queryFn: ({ signal }) =>
      getPitchAnalysis(season, pitcherId, signal, requestedCount, scope.options),
    enabled: pitcherId.length > 0 && !invalidCount && scope.error === null,
    placeholderData: (previous) =>
      !invalidCount &&
      previous?.season === season &&
      previous.pitcherId === pitcherId &&
      canonicalStringify(previous.scope) ===
        canonicalStringify(resolveAnalysisScope({ season, ...scope.options }))
        ? previous
        : undefined,
  });
  const updating = analysis.isPlaceholderData;
  const pitchType = params.get("type") ?? "";
  const colorMode: ColorMode = params.get("color") === "cluster" ? "cluster" : "provider";
  const clusterFilter = params.get("cluster") ?? "";
  const filter = colorMode === "cluster" ? clusterFilter : pitchType;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const types = useMemo(
    () =>
      [
        ...new Set(analysis.data?.points.map((point) => point.pitchType ?? "구종 미상") ?? []),
      ].sort(),
    [analysis.data],
  );
  const points = useMemo(
    () =>
      analysis.data?.points.filter(
        (point) => filter === "" || groupLabel(point, colorMode) === filter,
      ) ?? [],
    [analysis.data, filter, colorMode],
  );
  const groups = useMemo(() => {
    const grouped = new Map<
      string,
      { label: string; color: string; count: number; provider: Map<string, number> }
    >();
    for (const point of analysis.data?.points ?? []) {
      const label = groupLabel(point, colorMode);
      const group = grouped.get(label) ?? {
        label,
        color: pointColor(point, colorMode, types),
        count: 0,
        provider: new Map<string, number>(),
      };
      group.count++;
      const type = point.pitchType ?? "구종 미상";
      group.provider.set(type, (group.provider.get(type) ?? 0) + 1);
      grouped.set(label, group);
    }
    return [...grouped.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    );
  }, [analysis.data, colorMode, types]);
  const active = updating
    ? null
    : (points.find((point) => pitchKey(point) === selectedKey) ?? null);
  const data = analysis.data;
  const baseline = data?.baseline;
  const error = catalog.error ?? analysis.error;
  const scopeSummary = analysisScopeSummary(params);
  function change(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "clusterCount") {
      if (value === "") next.delete("clusterCount");
      next.delete("cluster");
    }
    if (key === "season" || key === "pitcher") next.delete("clusterCount");
    if (key === "season") {
      next.delete("pitcher");
      next.delete("dateFrom");
      next.delete("dateTo");
    }
    if (["competition", "dateFrom", "dateTo"].includes(key)) {
      next.delete("clusterCount");
      next.delete("cluster");
    }
    if (key === "season" || key === "pitcher" || key === "color") {
      next.delete("type");
      next.delete("cluster");
    }
    if (key !== "color" && key !== "clusterCount") setSelectedKey(null);
    setParams(next);
  }
  return (
    <div className="page-stack pitch-analysis-page">
      <header className="page-header">
        <div>
          <h1>투구 움직임</h1>
          <p>같은 순간의 3D 위치를 중계 구종과 클러스터 기준으로 비교합니다.</p>
        </div>
      </header>
      {scope.error && <p role="alert">{scope.error}</p>}
      <p>
        기준 포심과 구장 보정은 같은 시즌·경기 종류 전체를 사용합니다. 기간은 대상 투구에
        적용합니다.
      </p>
      <AnalysisFilterBar
        label="분석 대상"
        summary={scopeSummary}
        advanced={<AnalysisScopeFields params={params} onChange={change} />}
      >
        <label>
          시즌
          <select
            aria-label="분석 시즌"
            value={season}
            onChange={(event) => change("season", event.target.value)}
          >
            {[2020, 2021, 2022, 2023, 2024, 2025].map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label>
          투수
          <select
            aria-label="분석 투수"
            value={pitcherId}
            onChange={(event) => change("pitcher", event.target.value)}
            disabled={catalog.isPending}
          >
            {catalog.data?.pitchers.map((item) => (
              <option key={item.pitcherId} value={item.pitcherId}>
                {item.name} · {item.pitches.toLocaleString()}구
              </option>
            ))}
          </select>
        </label>
        <label>
          {colorMode === "cluster" ? "클러스터" : "구종"}
          <select
            aria-label={colorMode === "cluster" ? "분석 클러스터" : "분석 구종"}
            value={filter}
            onChange={(event) =>
              change(colorMode === "cluster" ? "cluster" : "type", event.target.value)
            }
          >
            <option value="">전체 {colorMode === "cluster" ? "클러스터" : "구종"}</option>
            {groups.map(({ label }) => (
              <option key={label}>{label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            void catalog.refetch();
            void analysis.refetch();
          }}
          disabled={analysis.isFetching || pitcherId === "" || invalidCount || scope.error !== null}
        >
          새로 계산
        </button>
      </AnalysisFilterBar>
      {invalidCount && (
        <p role="alert" className="panel">
          군집 수는 양의 정수여야 합니다.{" "}
          <button type="button" onClick={() => change("clusterCount", "")}>
            중계 구종 수로 초기화
          </button>
        </p>
      )}
      {error !== null && (
        <p role="alert" className="panel">
          {error.message}
          {countParam !== null && (
            <button type="button" onClick={() => change("clusterCount", "")}>
              중계 구종 수로 초기화
            </button>
          )}
        </p>
      )}
      {catalog.isLoading || analysis.isLoading ? (
        <p role="status" className="panel">
          시즌 평균 포심과 투구 궤적을 계산하는 중입니다.
        </p>
      ) : null}
      {catalog.data?.pitchers.length === 0 && (
        <p className="panel">선택한 기간과 경기 종류에 저장된 투구가 없습니다.</p>
      )}
      {data !== undefined && baseline === null && (
        <p className="panel">계산 가능한 직구가 없어 시즌 기준 궤적을 만들 수 없습니다.</p>
      )}
      {data !== undefined && (
        <section className="panel" aria-label="분석 표본 범위">
          <p>
            수집 경기 기준 · 대상 실제 투구 {data.actualPitchCount.toLocaleString()}구 · 표시 가능한
            구질 {data.points.length.toLocaleString()}구
          </p>
          <p>
            트래킹 누락 {data.missingTrackingCount.toLocaleString()}구 · 궤적 부적합{" "}
            {data.invalidTrackingCount.toLocaleString()}구 · 기준 미확보{" "}
            {Math.max(
              0,
              data.actualPitchCount -
                data.missingTrackingCount -
                data.invalidTrackingCount -
                data.points.length,
            ).toLocaleString()}
            구
          </p>
          <p>
            시즌 포심 기준 {baseline?.sampleCount.toLocaleString() ?? "0"}구 / 후보{" "}
            {baseline?.candidateCount.toLocaleString() ?? "0"}구
          </p>
          <Link to={`/analysis/coverage?season=${season}`}>시즌 전체 자료 품질 확인</Link>
        </section>
      )}
      {baseline !== null && baseline !== undefined && data !== undefined && (
        <>
          <section className="panel pitch-analysis-main">
            <header className="pitch-analysis-heading">
              <div>
                <span className="pitch-analysis-eyebrow">{season} 시즌 기준</span>
                <h2>
                  {pitcher?.name} <span>· 포심 대비 위치</span>
                </h2>
              </div>
              <div className="pitch-reference-time">
                <strong>
                  {baseline.arrivalMs.toFixed(1)}
                  <small> ms</small>
                </strong>
                <span>평균 포심 도착 시각</span>
              </div>
            </header>
            <p className="pitch-cluster-note" aria-label="구장 보정 현황">
              중간면 기준 · 구장 보정 {data.calibration.calibratedCount.toLocaleString()}구 · 미보정{" "}
              {data.calibration.uncalibratedCount.toLocaleString()}구. 각 경기 이전 84일의 자료로
              일별 보정하며, 최근 7일에 더 큰 가중치를 줍니다.
            </p>
            <div className="pitch-color-switch" role="group" aria-label="표시 기준">
              <button
                type="button"
                aria-pressed={colorMode === "provider"}
                onClick={() => change("color", "provider")}
              >
                중계 표기 기준
              </button>
              <button
                type="button"
                aria-pressed={colorMode === "cluster"}
                onClick={() => change("color", "cluster")}
              >
                클러스터링 기준
              </button>
            </div>
            {colorMode === "cluster" && (
              <div className="pitch-cluster-controls">
                <label>
                  군집 수
                  <select
                    aria-label="군집 수"
                    value={requestedCount ?? data.clustering.defaultClusterCount}
                    disabled={data.points.length === 0}
                    onChange={(event) => change("clusterCount", event.target.value)}
                  >
                    {data.points.length === 0 && <option value={0}>계산할 투구 없음</option>}
                    {Array.from(
                      { length: data.clustering.maxClusterCount },
                      (_, index) => index + 1,
                    ).map((count) => (
                      <option key={count} value={count}>
                        {count}개
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={countParam === null}
                  onClick={() => change("clusterCount", "")}
                >
                  중계 구종 수로 초기화
                </button>
                <span>기본 {data.clustering.defaultClusterCount}개 · GMM</span>
                <details>
                  <summary>기본값의 중계 구종 구성</summary>
                  <p>
                    {types
                      .map(
                        (type) =>
                          `${type} ${data.points.filter((p) => (p.pitchType ?? "구종 미상") === type).length.toLocaleString()}구`,
                      )
                      .join(" · ")}
                  </p>
                  <p>
                    유효 투구의 중계 구종 수를 사용합니다. 희소한 구종도 포함하며 구종 미상은
                    개수에서 제외합니다.
                  </p>
                </details>
              </div>
            )}
            <div className={updating ? "pitch-cluster-updating" : ""} aria-busy={updating}>
              {updating && (
                <p role="status" className="pitch-cluster-progress">
                  {requestedCount === undefined
                    ? "중계 구종 수 기준으로"
                    : `${requestedCount}개 군집으로`}{" "}
                  GMM 계산 중 · 아래는 이전 결과입니다.
                </p>
              )}
              <PitchShapeChart
                key={`${season}:${pitcherId}`}
                points={points}
                allPoints={data.points}
                referenceDistribution={data.referenceDistribution}
                colorMode={colorMode}
                selected={active}
                onSelect={(point) => setSelectedKey(pitchKey(point))}
              />
            </div>
            {!updating && (
              <>
                <div
                  className="pitch-group-legend"
                  aria-label={colorMode === "cluster" ? "클러스터 범례" : "중계 구종 범례"}
                >
                  {groups.map((group) => (
                    <button
                      type="button"
                      key={group.label}
                      aria-pressed={filter === "" || filter === group.label}
                      onClick={() =>
                        change(
                          colorMode === "cluster" ? "cluster" : "type",
                          filter === group.label ? "" : group.label,
                        )
                      }
                    >
                      <span className="pitch-group-swatch" style={{ background: group.color }} />
                      <span>
                        {group.label} <strong>{group.count.toLocaleString()}구</strong>
                        {colorMode === "cluster" && (
                          <small>
                            중계:{" "}
                            {[...group.provider]
                              .sort((a, b) => b[1] - a[1])
                              .map(([type, count]) => `${type} ${count}`)
                              .join(" · ")}
                          </small>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                {colorMode === "cluster" && (
                  <p className="pitch-cluster-note">
                    GMM 설정 {data.clustering.componentCount}개 · 실제 배정{" "}
                    {data.clustering.clusterCount}개 군집.
                    {data.clustering.status === "not_converged" &&
                      " 수렴한 분포를 찾지 못했습니다. 군집 수를 조정해 주세요."}
                    {data.clustering.status === "ready" &&
                      data.clustering.clusterCount < data.clustering.componentCount &&
                      " 공이 배정되지 않은 성분이 있습니다."}
                    {data.clustering.status === "empty" && " 계산 가능한 투구가 없습니다."} 클러스터
                    번호는 이 투수·시즌 안의 구분이며 구종명 확정이 아닙니다.
                  </p>
                )}
              </>
            )}
            {points.length === 0 && <p>선택 조건에서 계산 가능한 투구가 없습니다.</p>}
            <div className="pitch-analysis-coverage">
              <span>
                시즌 기준 직구 <strong>{baseline.sampleCount.toLocaleString()}구</strong> · 제외{" "}
                {baseline.excludedCount.toLocaleString()}구
              </span>
              <span>
                투수 전체 {data.actualPitchCount.toLocaleString()}구 · 계산{" "}
                {data.points.length.toLocaleString()}구 · 트래킹 없음{" "}
                {data.missingTrackingCount.toLocaleString()}구 · 계산 제외{" "}
                {data.invalidTrackingCount.toLocaleString()}구
              </span>
            </div>
          </section>
          <section className="panel pitch-selected" aria-label="선택한 투구" aria-live="polite">
            {active === null ? (
              <p>공을 선택하면 위치 차이와 도착 시간 차이를 확인할 수 있습니다.</p>
            ) : (
              <>
                <div>
                  <strong>{active.pitchType ?? "구종 미상"}</strong>
                  <span>{groupLabel(active, "cluster")}</span>
                  <span>
                    {active.gameDate} ·{" "}
                    {active.speedKph === null ? "구속 미상" : `${active.speedKph.toFixed(1)} km/h`}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>좌우 차이</dt>
                    <dd>{signed(active.xCm)} cm</dd>
                  </div>
                  <div>
                    <dt>높이 차이</dt>
                    <dd>{signed(active.zCm)} cm</dd>
                  </div>
                  <div>
                    <dt>도착 시간 차이</dt>
                    <dd>{signed(active.timingDifferenceMs)} ms</dd>
                  </div>
                  <div>
                    <dt>그 순간의 위치</dt>
                    <dd>
                      {active.extrapolated
                        ? "플레이트 통과 후 · 외삽"
                        : `플레이트까지 ${(active.distanceToPlateCm / 100).toFixed(2)} m`}
                    </dd>
                  </div>
                </dl>
                <p>
                  {referenceBandLabel(active.referenceBand)} ·{" "}
                  {active.whiff ? "헛스윙" : active.swing ? "스윙 · 접촉" : "스윙 없음"}
                </p>
                <p>
                  {active.stadium ?? "구장 미상"} ·{" "}
                  {active.calibrationStatus === "applied"
                    ? `구장 보정 적용 · 관측 편향 좌우 ${signed(active.calibrationXcm ?? 0)} cm, 높이 ${signed(active.calibrationZcm ?? 0)} cm 차감`
                    : active.calibrationStatus === "unsupported_park"
                      ? "구장 보정 미적용 · 비교 자료가 없는 구장"
                      : "구장 보정 미적용 · 이전 경기 표본 부족"}
                </p>
                <span className="pitch-source-id">
                  {active.gameId} · revision {active.revision} · {active.pitchId}
                </span>
              </>
            )}
          </section>
          {!updating && <PitchExpectationPanel data={data} colorMode={colorMode} filter={filter} />}
          <details className="panel pitch-analysis-method">
            <summary>평균 포심과 비교 방식</summary>
            <p>
              모든 시즌의 플레이트 평가면을 중간면으로 통일하고, 투구와 기준 포심 모두 해당 경기
              날짜의 구장 편향을 보정합니다. 당일과 이후 경기의 자료는 그날의 보정계수에 사용하지
              않습니다. 과거 비교 표본이 부족하거나 미지원 구장이면 중간면에서 계산한 미보정 좌표를
              포함하며, 적용 여부를 투구별로 표시합니다.
            </p>
            <p>
              해당 시즌에 DB에 저장된 경기의 현재 리비전 중 ‘직구’를 포심으로 사용합니다. 좌·우완을
              합산하고 투구마다 같은 가중치를 줍니다. 투수·구종 필터는 기준 집단을 바꾸지 않습니다.
            </p>
            <p>
              50피트에서의 출발 위치와 초기 진행 방향을 정렬합니다. 각 공의 비행 시간은 유지하고,
              평균 궤적이 플레이트에 닿는 한 시각에서 모든 공의 좌우(X)·높이(Z)·플레이트까지
              거리(Y)를 비교합니다. 십자선은 그 순간의 평균 포심입니다. 거리 양수는 플레이트 이전,
              음수는 통과 이후입니다. 축별 확대는 분포를 보기 위한 표시 비율이며 실제 길이 비율로
              전환할 수 있습니다.
            </p>
            <p>
              색은 선택한 중계 구종 또는 클러스터를 나타냅니다. 도착 시간 차이는 공을 선택하면
              확인할 수 있습니다. 먼저 도착한 공의 점은 플레이트 통과 후까지 모델을 연장한 외삽
              위치입니다.
            </p>
            <p>
              클러스터는 선택한 대상 투구의 X·Z·Y를 축별 표준화한 GMM으로 계산합니다. 중계 구종 수를
              기본 군집 수로 사용하며, 군집 수를 바꾸면 다시 계산합니다. 각 공의 배정에는 좌표만
              사용하고 중계 구종과 시간차는 넣지 않습니다. 표시 기준·필터·회전·확대는 계산 결과를
              바꾸지 않습니다. 모든 공을 가장 높은 소속 확률의 군집에 배정하므로, 배정됐다는 사실이
              이상치가 없다는 뜻은 아닙니다. 원본 중계 표기는 유지하며 같은 번호가 다른 군집 수나
              데이터에서도 같은 구종을 뜻하지는 않습니다.
            </p>
            <p>
              기준 표본 경기일 {baseline.firstGameDate} ~ {baseline.lastGameDate} · 50피트 기준 평균
              속력 {baseline.speedKphAt50Feet.toFixed(1)} km/h. 저장 경기 범위의 평균이며 리그 전체
              수집 완료를 뜻하지 않습니다.
            </p>
          </details>
        </>
      )}
      {data && <PitchProfilePanel profile={data.profile} />}
      {data && !updating && (
        <PitchAnglesPanel
          pitcherId={pitcherId}
          query={{ season, competition: "all", ...scope.options }}
        />
      )}
      {data && !updating && (
        <PitchQualityPanel
          pitcherId={pitcherId}
          query={{ season, competition: "all", ...scope.options }}
        />
      )}
    </div>
  );
}
