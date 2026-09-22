import { AnalysisScopeFields, scopeFromParams } from "../analysis/analysis-scope-fields";
import { DisciplinePeriodComparison } from "../analysis/discipline-period-comparison";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DisciplineQuerySchema, type DisciplinePoint } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { getBatterDiscipline, getDisciplineCatalog } from "../api/batter-discipline-client";
import { DisciplineCourseComparison } from "../analysis/discipline-course-comparison";
import {
  ComparisonTable,
  SwingMap,
  DeviationBars,
  SelectedDisciplinePitch,
  percent,
  transitionLabels,
  deviationLabels,
} from "../analysis/discipline-panels";
import "../styles/pitch-analysis.css";
import "../styles/batter-discipline.css";

const identity = (p: DisciplinePoint) => JSON.stringify([p.gameId, p.revision, p.pitchId]);
export function BatterDisciplinePage() {
  const [params, setParams] = useSearchParams();
  const requestedSeason = Number(params.get("season"));
  const season =
    Number.isInteger(requestedSeason) && requestedSeason >= 1982 && requestedSeason <= 2026
      ? requestedSeason
      : 2025;
  const scope = scopeFromParams(season, params);
  const candidate = {
    ...scope.options,
    ...(params.has("leaguePeriod") ? { leaguePeriod: params.get("leaguePeriod") } : {}),
    season,
    ...(params.has("balls") ? { balls: Number(params.get("balls")) } : {}),
    ...(params.has("strikes") ? { strikes: Number(params.get("strikes")) } : {}),
    ...(params.has("pitchType") ? { pitchType: params.get("pitchType") } : {}),
    ...(params.has("stance") ? { stance: params.get("stance") } : {}),
  };
  const valid = scope.error === null && Value.Check(DisciplineQuerySchema, candidate);
  const catalog = useQuery({
    queryKey: ["discipline-catalog", season, scope.options],
    queryFn: ({ signal }) => getDisciplineCatalog(season, signal, scope.options),
    enabled: scope.error === null,
  });
  const requested = params.get("batter");
  const batter =
    requested === null
      ? catalog.data?.batters[0]
      : catalog.data?.batters.find((b) => b.batterId === requested);
  const batterId = batter?.batterId ?? "";
  const analysis = useQuery({
    queryKey: ["batter-discipline", batterId, candidate],
    enabled: valid && batterId !== "",
    queryFn: ({ signal }) => {
      if (!Value.Check(DisciplineQuerySchema, candidate))
        throw new Error("잘못된 선구안 필터입니다.");
      return getBatterDiscipline(candidate, batterId, signal);
    },
  });
  const [cell, setCell] = useState<number | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const axis = params.get("axis") === "x" ? "x" : params.get("axis") === "timing" ? "timing" : "z";
  const difference = params.get("map") === "difference";
  const data = analysis.data;
  const points = data?.points.filter((p) => cell === null || p.cell === cell) ?? [];
  const selected = points.find((p) => identity(p) === selection);
  const shown = points.slice(page * 20, page * 20 + 20);
  const course = data?.courseComparison.conventional.batter;
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (key === "reset") {
      for (const k of ["balls", "strikes", "pitchType", "stance"]) next.delete(k);
    } else if (key === "count") {
      next.delete("balls");
      next.delete("strikes");
      if (value !== "") {
        const [balls, strikes] = value.split("-");
        if (balls !== undefined && balls !== "*") next.set("balls", balls);
        if (strikes !== undefined && strikes !== "*") next.set("strikes", strikes);
      }
    } else {
      if (value === "") next.delete(key);
      else next.set(key, value);
    }
    if (key === "season") {
      next.delete("batter");
      next.delete("dateFrom");
      next.delete("dateTo");
      next.delete("compareFrom");
      next.delete("compareTo");
    }
    if (key === "season" || key === "batter") next.delete("pitchType");
    if (key !== "axis" && key !== "map") {
      setCell(null);
      setSelection(null);
      setPage(0);
    }
    setParams(next);
  }
  return (
    <div className="page-stack discipline-page">
      <header className="page-header">
        <div>
          <h1>타자 선구안</h1>
          <p>어떤 공을 참고, 어떤 공에 방망이가 나오는지 살펴봅니다.</p>
        </div>
      </header>
      <p>
        포심 기준은 같은 시즌·경기 종류 전체입니다. 실제 코스는 원천 도착면과 기존 존 정의를
        사용합니다.
      </p>
      {scope.error && <p role="alert">{scope.error}</p>}
      <section className="panel pitch-analysis-toolbar" aria-label="선구안 분석 조건">
        <AnalysisScopeFields params={params} onChange={change} />
        <label>
          리그 비교 기간
          <select
            aria-label="리그 비교 기간"
            value={params.get("leaguePeriod") ?? "season"}
            onChange={(e) => change("leaguePeriod", e.target.value)}
          >
            <option value="season">시즌 전체</option>
            <option value="target">대상과 같은 기간</option>
          </select>
        </label>
        <label>
          시즌
          <select
            aria-label="선구안 시즌"
            value={season}
            onChange={(e) => change("season", e.target.value)}
          >
            {Array.from({ length: 45 }, (_, i) => 2026 - i).map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label>
          타자
          <select
            aria-label="분석 타자"
            value={batterId}
            disabled={catalog.isPending}
            onChange={(e) => change("batter", e.target.value)}
          >
            {!batter && <option value="">타자를 선택하세요</option>}
            {catalog.data?.batters.map((b) => (
              <option key={b.batterId} value={b.batterId}>
                {b.name} · {b.pitches.toLocaleString()}구
              </option>
            ))}
          </select>
        </label>
        <label>
          카운트
          <select
            aria-label="선구안 카운트"
            value={
              params.has("balls") || params.has("strikes")
                ? `${params.get("balls") ?? "*"}-${params.get("strikes") ?? "*"}`
                : ""
            }
            onChange={(e) => change("count", e.target.value)}
          >
            <option value="">전체 카운트</option>
            <optgroup label="스트라이크별">
              {[0, 1, 2].map((s) => (
                <option key={s} value={`*-${s}`}>
                  {s}스트라이크 · 모든 볼카운트
                </option>
              ))}
            </optgroup>
            <optgroup label="볼별">
              {[0, 1, 2, 3].map((b) => (
                <option key={b} value={`${b}-*`}>
                  {b}볼 · 모든 스트라이크
                </option>
              ))}
            </optgroup>
            {[0, 1, 2, 3].flatMap((b) =>
              [0, 1, 2].map((s) => (
                <option key={`${b}-${s}`} value={`${b}-${s}`}>
                  {b}B {s}S
                </option>
              )),
            )}
          </select>
        </label>
        <label>
          중계 구종
          <select
            aria-label="선구안 구종"
            value={params.get("pitchType") ?? ""}
            onChange={(e) => change("pitchType", e.target.value)}
          >
            <option value="">전체 구종</option>
            {[
              ...new Set([
                ...(data?.pitchTypes ?? []),
                ...(params.has("pitchType") ? [params.get("pitchType") ?? ""] : []),
              ]),
            ].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          타석
          <select
            aria-label="선구안 타석"
            value={params.get("stance") ?? ""}
            onChange={(e) => change("stance", e.target.value)}
          >
            <option value="">전체 · 미상 포함</option>
            <option value="L">좌타석</option>
            <option value="R">우타석</option>
            <option value="S">스위치 표기</option>
          </select>
        </label>
        <button type="button" onClick={() => change("reset", "")}>
          조건 초기화
        </button>
      </section>
      {!valid && <p role="alert">분석 조건이 올바르지 않습니다. 조건 초기화로 다시 시작하세요.</p>}
      {(catalog.error || analysis.error) && (
        <div className="panel" role="alert">
          {(catalog.error ?? analysis.error)?.message}
          <button
            type="button"
            onClick={() => {
              void catalog.refetch();
              void analysis.refetch();
            }}
          >
            다시 시도
          </button>
        </div>
      )}
      {catalog.isPending || (valid && batterId !== "" && analysis.isPending) ? (
        <p className="panel" role="status">
          선구안 분석 중입니다. 시즌 첫 조회는 조금 걸릴 수 있습니다.
        </p>
      ) : null}
      {catalog.data?.batters.length === 0 && (
        <p className="panel">이 시즌에 저장된 타자 투구가 없습니다.</p>
      )}
      {requested !== null && catalog.isSuccess && batter === undefined && (
        <p role="alert">이 시즌에서 요청한 타자를 찾을 수 없습니다.</p>
      )}
      {valid && data && (
        <>
          <DisciplinePeriodComparison
            data={data}
            params={params}
            onChange={change}
            onRefresh={() => void analysis.refetch()}
          />
          <div className="discipline-metrics">
            <div>
              <span>기존 코스 · 존 판정 가능</span>
              <strong>
                {data.courseComparison.conventional.batter.pitches.toLocaleString()}
                <small>구</small>
              </strong>
              <small>{batter?.name} · 선택 조건</small>
            </div>
            <div>
              <span>존 밖 스윙률 · Chase%</span>
              <strong>{percent(course?.chaseRate ?? null)}</strong>
              <small>
                {course?.outsideSwings ?? 0} / {course?.outsidePitches ?? 0}구
              </small>
            </div>
            <div>
              <span>존 안 스윙률 · Z-Swing%</span>
              <strong>{percent(course?.zoneSwingRate ?? null)}</strong>
              <small>
                {course?.zoneSwings ?? 0} / {course?.zonePitches ?? 0}구
              </small>
            </div>
            <div>
              <span>포심 가정 비교 가능</span>
              <strong>
                {data.coverage.comparisonPitches.toLocaleString()}
                <small>구</small>
              </strong>
              <small>위치와 도착 시간 비교</small>
            </div>
          </div>
          {data.coverage.locationPitches === 0 && (
            <p className="panel">선택 조건에서 코스를 계산할 수 있는 투구가 없습니다.</p>
          )}
          <DisciplineCourseComparison data={data} />
          <div className="discipline-columns">
            <section className="panel discipline-panel">
              <span className="pitch-analysis-eyebrow">01 · 실제 코스</span>
              <h2>어디에 오는 공에 반응했나</h2>
              <div className="discipline-toggle" aria-label="지도 표시">
                <button type="button" aria-pressed={!difference} onClick={() => change("map", "")}>
                  스윙률
                </button>
                <button
                  type="button"
                  aria-pressed={difference}
                  onClick={() => change("map", "difference")}
                >
                  리그와 차이
                </button>
              </div>
              <SwingMap
                cells={data.cells}
                selected={cell}
                difference={difference}
                onSelect={(value) => {
                  setCell(value);
                  setPage(0);
                  setSelection(null);
                }}
              />
              <p className="discipline-caption">
                {difference
                  ? "주황: 리그보다 더 스윙 · 파랑: 덜 스윙 · 단위 %p"
                  : "진한 초록일수록 스윙률이 높습니다."}{" "}
                색은 판단의 좋고 나쁨을 뜻하지 않습니다.
              </p>
              <ComparisonTable
                groups={
                  cell === null ? data.summary : data.cells.filter((g) => g.key === String(cell))
                }
                labels={{
                  zone: "존 안",
                  outside: "존 밖",
                  ...(cell === null ? {} : { [String(cell)]: `선택 코스 ${cell + 1}` }),
                }}
                caption="코스별 스윙 비교"
              />
            </section>
            <section className="panel discipline-panel">
              <span className="pitch-analysis-eyebrow">02 · 포심 가정 대비</span>
              <h2>예상 궤적에서 달라지면</h2>
              <p className="discipline-caption">
                같은 출발 위치·방향에서 시즌 평균 포심이었다면 도착했을 위치와 비교합니다.
              </p>
              {data.baseline === null ? (
                <p>시즌 기준 포심이 없어 궤적 비교를 할 수 없습니다.</p>
              ) : (
                <>
                  <div className="discipline-toggle" aria-label="편차 축">
                    {(["z", "x", "timing"] as const).map((a) => (
                      <button
                        type="button"
                        key={a}
                        aria-pressed={axis === a}
                        onClick={() => change("axis", a)}
                      >
                        {a === "z" ? "높이 차이" : a === "x" ? "좌우 차이" : "도착 시간차"}
                      </button>
                    ))}
                  </div>
                  <p className="discipline-caption">
                    실제 − 포심 ·{" "}
                    {axis === "z"
                      ? "음수: 더 낮게 / 양수: 더 높게"
                      : axis === "x"
                        ? "원천 X축의 좌우 부호를 유지합니다."
                        : "음수: 먼저 도착 / 양수: 늦게 도착"}
                  </p>
                  <DeviationBars
                    groups={data.deviations[axis]}
                    unit={axis === "timing" ? "ms" : "cm"}
                  />
                  <ComparisonTable
                    groups={data.deviations[axis]}
                    labels={Object.fromEntries(
                      deviationLabels.map((label, i) => [String(i), label]),
                    )}
                    caption="편차 구간별 스윙 비교"
                  />
                </>
              )}
            </section>
          </div>
          <section className="panel discipline-panel">
            <h2>포심 가정 → 실제 존 도착</h2>
            <p className="discipline-caption">
              ‘존 안 → 존 밖’의 스윙률과 ‘존 안 → 존 안’의 공격 비율을 함께 살펴보세요. 포심 가정은
              타자의 실제 인식을 측정한 값이 아닙니다.
            </p>
            <ComparisonTable
              groups={data.transitions}
              labels={transitionLabels}
              caption="포심 가정과 실제 존 판정에 따른 스윙"
            />
          </section>
          <section className="panel discipline-panel">
            <h2>
              {cell === null ? "분석에 포함된 투구" : `선택 코스 ${cell + 1}의 투구`}{" "}
              <small>{points.length.toLocaleString()}구</small>
            </h2>
            <div className="discipline-pitch-list" aria-label="선구안 투구 목록">
              {shown.map((p) => (
                <button
                  key={identity(p)}
                  type="button"
                  aria-pressed={selection === identity(p)}
                  onClick={() => setSelection(identity(p))}
                >
                  <span>
                    {p.gameDate} · {p.pitchType ?? "구종 미상"}
                  </span>
                  <span>
                    {p.balls}B {p.strikes}S · {p.inZone ? "존 안" : "존 밖"}
                  </span>
                  <strong>{p.swing ? (p.whiff ? "스윙 · 헛스윙" : "스윙 · 접촉") : "참음"}</strong>
                </button>
              ))}
            </div>
            <div className="discipline-pagination">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                이전
              </button>
              <span>
                {points.length === 0 ? 0 : page + 1} / {Math.ceil(points.length / 20)}
              </span>
              <button disabled={(page + 1) * 20 >= points.length} onClick={() => setPage(page + 1)}>
                다음
              </button>
              {cell !== null && (
                <button
                  onClick={() => {
                    setCell(null);
                    setPage(0);
                  }}
                >
                  전체 코스
                </button>
              )}
            </div>
            {selected && <SelectedDisciplinePitch point={selected} />}
          </section>
          <section className="panel discipline-panel discipline-method">
            <h2>표본과 비교 기준</h2>
            <p>
              선택 타자 전체 {data.coverage.actualPitches.toLocaleString()}구 · 번트/고의사구 타석
              및 사구/번트 파울 제외 {data.coverage.excludedSituations.toLocaleString()}구 · 위치
              미확인 {data.coverage.missingLocation.toLocaleString()}구. 다른 타자의 코스 확인 표본{" "}
              {data.coverage.leagueLocationPitches.toLocaleString()}구.
            </p>
            <p>
              리그 비교는 선택 타자를 제외하고 카운트·중계 구종·타석 좌우(미상 별도)·5 km/h
              구속대·코스 칸·존 안팎을 맞춥니다. 각 조건의 다른 타자 표본이 20구 이상일 때만
              비교하며, 그 스윙률을 선택 타자가 받은 공 수로 가중합니다. 편차·존 전이 표는 해당
              구간도 같아야 합니다.
            </p>
            <p>
              ‘타자 / 리그’와 차이는 비교 가능한 동일 표본만 사용합니다. 리그 평균은 최적 선택이나
              타자의 인식 확률이 아닙니다. 투수 좌우·상대 투수·배합·작전·타자별 타격 능력은 보정하지
              않았습니다. 헛스윙은 스윙을 선택한 뒤의 결과로 따로 표시합니다.
            </p>
            <details>
              <summary>포심 가정 계산과 수집 범위</summary>
              <p>
                50피트 위치와 초기 진행 방향을 유지하고 시즌 평균 포심의 속도·곡률을 적용합니다.
                실제 공과 가정한 포심이 각자 플레이트에 도착한 위치를 비교하므로, 투구 움직임 화면의
                ‘같은 순간’ 좌표와 정의가 다릅니다. 실제 가로는 제공된 crossPlateX, 높이는 궤적의
                플레이트 교차 높이를 사용합니다.
              </p>
              <p>
                시즌 ‘직구’를 포심으로 사용하며 좌·우완을 합산합니다.{" "}
                {data.baseline
                  ? `기준 ${data.baseline.sampleCount.toLocaleString()}구 · ${data.baseline.firstGameDate} ~ ${data.baseline.lastGameDate}.`
                  : "기준 포심 없음."}{" "}
                저장된 경기 범위의 평균입니다. 50피트 이전의 관찰과 실제 스윙 시작 시각은 추정하지
                않습니다.
              </p>
            </details>
          </section>
        </>
      )}
    </div>
  );
}
