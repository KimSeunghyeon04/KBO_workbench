import { AnalysisSeasonOptions, useAnalysisSeason } from "../analysis/analysis-seasons";
import { AnalysisScopeFields, competitionLabels } from "../analysis/analysis-scope-fields";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import {
  analysisScopeSearch,
  changeAnalysisParams,
  scopeFromParams,
} from "../analysis/analysis-scope";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import "../styles/pitch-analysis.css";
import "../styles/analysis-coverage.css";
import { Link, useSearchParams } from "react-router-dom";
import type { AnalysisCoverageCounts, AnalysisCoverageResult } from "@kbo/contracts";
import { getAnalysisCoverage } from "../api/analysis-coverage-client";

const rate = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);
function Counts({ counts: c }: { counts: AnalysisCoverageCounts }) {
  return (
    <div className="coverage-overview">
      <dl className="coverage-totals">
        <div>
          <dt>수집 경기</dt>
          <dd>{c.games.toLocaleString()}</dd>
        </div>
        <div>
          <dt>실제 투구</dt>
          <dd>{c.actualPitches.toLocaleString()}</dd>
        </div>
        <div>
          <dt>완료 타석</dt>
          <dd>{c.completedPlateAppearances.toLocaleString()}</dd>
        </div>
      </dl>
      <dl className="coverage-field-rates">
        {[
          { label: "구종 보유", value: c.withPitchType },
          { label: "구속 보유", value: c.withSpeed },
          { label: "존 판정 가능", value: c.zoneKnown },
        ].map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <strong>{rate(value, c.actualPitches)}</strong>
              <span>
                {value.toLocaleString()} / {c.actualPitches.toLocaleString()}구
              </span>
              <meter
                min={0}
                max={Math.max(1, c.actualPitches)}
                value={value}
                aria-label={`${label}`}
                aria-valuetext={`${value} / ${c.actualPitches}구`}
              />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
export function AnalysisCoveragePage() {
  const [params, setParams] = useSearchParams();
  const season = useAnalysisSeason(params.get("season"));
  const scope = scopeFromParams(season, params);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next);
  }
  const client = useQueryClient();
  const queryKey = ["analysis-coverage", season, scope.options];
  const query = useQuery<AnalysisCoverageResult>({
    queryKey,
    refetchInterval: (query) =>
      query.state.data && "state" in query.state.data && query.state.data.state === "preparing"
        ? 1000
        : false,
    enabled: scope.error === null,
    queryFn: ({ signal }) => getAnalysisCoverage(season, signal, scope.options),
  });
  const retry = useMutation({
    mutationFn: ({
      selectedSeason,
      options,
    }: {
      selectedSeason: number;
      options: typeof scope.options;
    }) => getAnalysisCoverage(selectedSeason, new AbortController().signal, options, true),
    onSuccess: (data, variables) =>
      client.setQueryData(["analysis-coverage", variables.selectedSeason, variables.options], data),
  });
  const data = query.data && !("state" in query.data) ? query.data : undefined;
  const preparation = query.data && "state" in query.data ? query.data : undefined;
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>분석 자료 품질</h1>
          <p>수집 경기의 필드 보유와 실제 계산 가능 범위를 확인합니다.</p>
        </div>
      </header>
      <section className="panel pitch-analysis-toolbar">
        <label>
          시즌{" "}
          <select
            aria-label="시즌"
            value={season}
            onChange={(event) =>
              setParams(changeAnalysisParams(params, "season", event.target.value))
            }
          >
            <AnalysisSeasonOptions season={season} />
          </select>
        </label>
        <AnalysisScopeFields params={params} onChange={change} />
      </section>
      {scope.error && <p role="alert">{scope.error}</p>}
      {query.isLoading && (
        <p className="panel" role="status">
          분석 가능 표본을 확인하고 있습니다.
        </p>
      )}
      <AnalysisQueryError queries={[query]} enabled={scope.error === null} />
      {preparation?.state === "preparing" && (
        <p className="panel" role="status">
          품질 요약을 준비하고 있습니다. 완료되면 자동으로 표시합니다.
        </p>
      )}
      {preparation?.state === "failed" && (
        <section className="panel">
          <p role="alert">품질 요약을 준비하지 못했습니다.</p>
          <button
            type="button"
            disabled={retry.isPending}
            onClick={() => retry.mutate({ selectedSeason: season, options: scope.options })}
          >
            다시 준비
          </button>
        </section>
      )}
      {retry.error && <p role="alert">{retry.error.message}</p>}
      {data && (
        <>
          <section className="panel">
            <h2>수집 범위</h2>
            <p>
              {data.firstGameDate ?? "—"} ~ {data.lastGameDate ?? "—"} · 경기 종류 미분류{" "}
              {data.unclassifiedGames.toLocaleString()}경기
            </p>
            <p>
              공식 전체 경기 확보율이 아닙니다. 경기 종류가 확인되기 전에는 정규시즌 전체 성적으로
              해석하지 않습니다.
            </p>
            <p>
              {data.competitions
                .map((c) => `${competitionLabels[c.competition]} ${c.games.toLocaleString()}경기`)
                .join(" · ")}
            </p>
            <Counts counts={data.total} />
          </section>
          <section className="panel">
            <h2>구장별 계산 가능 표본</h2>
            <p>
              유효 궤적은 중간면 구질 계산 기준입니다. 존 판정은 실제 도착 코스의 별도 기준입니다.
            </p>
            <ul className="coverage-park-list" aria-label="구장별 유효 궤적 비율">
              {data.stadiums.map(({ stadium, counts: c }) => (
                <li key={stadium ?? "unknown"}>
                  <div className="coverage-park-heading">
                    <strong>{stadium ?? "구장 미상"}</strong>
                    <span>
                      유효 궤적 <b>{rate(c.validTrajectory, c.actualPitches)}</b>
                    </span>
                  </div>
                  <div className="coverage-park-bar" aria-hidden="true">
                    <span style={{ flexGrow: c.validTrajectory }} />
                    <span style={{ flexGrow: c.missingTracking }} />
                    <span style={{ flexGrow: c.invalidTrajectory }} />
                  </div>
                  <p>
                    실제 {c.actualPitches.toLocaleString()}구 중 유효{" "}
                    {c.validTrajectory.toLocaleString()}구 · 누락{" "}
                    {c.missingTracking.toLocaleString()}구 · 부적합{" "}
                    {c.invalidTrajectory.toLocaleString()}구
                  </p>
                </li>
              ))}
            </ul>
            <details className="coverage-park-details">
              <summary>구장별 상세 수치와 보정 표본</summary>
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="구장별 상세 수치"
              >
                <table>
                  <thead>
                    <tr>
                      <th>구장</th>
                      <th>경기</th>
                      <th>실제 투구</th>
                      <th>트래킹 누락</th>
                      <th>궤적 부적합</th>
                      <th>유효 궤적</th>
                      <th>보정 적용</th>
                      <th>보정 자료 부족</th>
                      <th>구장 미지원</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stadiums.map(({ stadium, counts: c }) => (
                      <tr key={stadium ?? "unknown"}>
                        <th>{stadium ?? "구장 미상"}</th>
                        {[
                          c.games,
                          c.actualPitches,
                          c.missingTracking,
                          c.invalidTrajectory,
                          c.validTrajectory,
                          c.calibratedTrajectory,
                          c.insufficientCalibration,
                          c.unsupportedPark,
                        ].map((value, index) => (
                          <td key={index}>{value.toLocaleString()}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            {data.total.games === 0 && <p>선택한 기간과 경기 종류에 저장된 경기가 없습니다.</p>}
            <p>
              실제 투구 = 트래킹 누락 + 궤적 부적합 + 유효 궤적. 유효 궤적 = 보정 적용 + 자료 부족 +
              구장 미지원.
            </p>
            <Link to={`/analysis/pitch-shape?${analysisScopeSearch(season, scope.options)}`}>
              투수별 구질 보기
            </Link>
          </section>
        </>
      )}
    </div>
  );
}
