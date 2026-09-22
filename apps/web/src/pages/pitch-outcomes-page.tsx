import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { PitchOutcomeQuerySchema } from "@kbo/contracts";
import { AnalysisScopeFields, scopeFromParams } from "../analysis/analysis-scope-fields";
import {
  PitchRateTable,
  PitchLocationMap,
  TerminalBattingPanel,
} from "../analysis/pitch-outcome-panels";
import { getPitchAnalysisCatalog } from "../api/pitch-analysis-client";
import { getDisciplineCatalog } from "../api/batter-discipline-client";
import { getPitchLocation, getBatterProfile } from "../api/pitch-outcomes-client";
import "../styles/pitch-analysis.css";
import "../styles/batter-discipline.css";
export function PitchOutcomesPage({ role }: { role: "pitcher" | "batter" }) {
  const [params, setParams] = useSearchParams();
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const season = Number(params.get("season") ?? 2025),
    scope = scopeFromParams(season, selected);
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
  const catalog = useQuery({
    queryKey: ["outcome-catalog", role, season, scope.options],
    enabled: scope.error === null,
    queryFn: async ({ signal }) => {
      if (role === "pitcher")
        return (await getPitchAnalysisCatalog(season, signal, scope.options)).pitchers.map((p) => ({
          id: p.pitcherId,
          name: p.name,
        }));
      return (await getDisciplineCatalog(season, signal, scope.options)).batters.map((p) => ({
        id: p.batterId,
        name: p.name,
      }));
    },
  });
  const id = params.get(role) ?? catalog.data?.[0]?.id ?? "";
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
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key === "season") {
      next.delete("dateFrom");
      next.delete("dateTo");
      next.delete(role);
    }
    setParams(next);
  }
  const data = analysis.data;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>{role === "pitcher" ? "투수 코스와 결정구" : "타자 반응과 종결 성적"}</h1>
          <p>실제 투구의 사용과 결과를 관측된 분모로 비교합니다.</p>
        </div>
      </header>
      <section className="panel pitch-analysis-toolbar" aria-label="투구 결과 조건">
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
        <AnalysisScopeFields params={selected} onChange={change} />
        <label>
          {role === "pitcher" ? "투수" : "타자"}
          <select aria-label="분석 선수" value={id} onChange={(e) => change(role, e.target.value)}>
            {catalog.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
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
      </section>
      {!valid && <p role="alert">{scope.error ?? "투구 조건이 올바르지 않습니다."}</p>}
      {(analysis.error || catalog.error) && (
        <p role="alert">{String(analysis.error ?? catalog.error)}</p>
      )}
      {catalog.isPending || analysis.isFetching ? (
        <p role="status">분석 자료를 읽고 있습니다.</p>
      ) : null}
      {catalog.data?.length === 0 && (
        <p>
          이 범위에 확인된 선수가 없습니다. <Link to="/analysis/coverage">자료 품질 확인</Link>
        </p>
      )}
      {data && (
        <>
          <section className="panel">
            <p>
              기간 내 {data.coverage.scopePitches}구 → 조건 {data.coverage.filteredPitches}구 → 상황
              제외 {data.coverage.excludedSituations}구 → 반응 {data.total.pitches}구. 지도{" "}
              {data.coverage.locationPitches}구 / 좌표·존 미확인 {data.coverage.missingLocation}구.
              자동 삼진 {data.coverage.automaticStrikeouts}개.
            </p>
            <Link
              to={`/analysis/${role === "pitcher" ? "pitch-shape" : "batter-discipline"}?${new URLSearchParams({ season: String(season), ...scope.options, [role]: id })}`}
            >
              {role === "pitcher" ? "같은 범위 구질 보기" : "조건 일치 선구안 비교"}
            </Link>
          </section>
          <PitchRateTable title="전체 반응" rows={[data.total]} />
          <PitchLocationMap
            key={JSON.stringify([id, candidate, data.sourceHash])}
            cells={data.cells}
            points={data.points}
          />
          <PitchRateTable title="구종별 반응" rows={data.byType} />
          <PitchRateTable title="카운트별 반응" rows={data.byCount} />
          <PitchRateTable title="타석 좌우별 반응" rows={data.byStance} />
          {"batterId" in data && (
            <>
              <PitchRateTable title="구속대별 반응" rows={data.bySpeed} />
              <TerminalBattingPanel key={data.sourceHash} data={data.plateAppearances} />
            </>
          )}
        </>
      )}
    </div>
  );
}
