import { useQuery } from "@tanstack/react-query";
import "../styles/pitch-analysis.css";
import { Link, useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import { BattingStatisticsQuerySchema, PitchingStatisticsQuerySchema } from "@kbo/contracts";
import { BattingTable, PitchingTable } from "../analysis/player-statistics-tables";
import { AnalysisScopeFields } from "../analysis/analysis-scope-fields";
import {
  analysisScopeSearch,
  changeAnalysisParams,
  scopeFromParams,
} from "../analysis/analysis-scope";
import { getBattingStatistics, getPitchingStatistics } from "../api/player-statistics-client";

export function PlayerStatisticsPage() {
  const [params, setParams] = useSearchParams();
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const season = Number(params.get("season") ?? 2025),
    scope = scopeFromParams(season, selected);
  const kind = params.get("kind") === "pitching" ? "pitching" : "batting";
  const common = {
    season,
    ...scope.options,
    group: params.get("group") ?? "player",
    page: Number(params.get("page") ?? 1),
    limit: 50,
  };
  const batting = {
    ...common,
    sort: params.get("sort") ?? "ops",
    minPA: Number(params.get("minimum") ?? 0),
  };
  const pitching = {
    ...common,
    sort: params.get("sort") ?? "kMinusBbRate",
    minBF: Number(params.get("minimum") ?? 0),
  };
  const validBatting = Value.Check(BattingStatisticsQuerySchema, batting),
    validPitching = Value.Check(PitchingStatisticsQuerySchema, pitching);
  const bat = useQuery({
    queryKey: ["statistics-batting", batting],
    enabled: kind === "batting" && validBatting && scope.error === null,
    queryFn: ({ signal }) => {
      if (!Value.Check(BattingStatisticsQuerySchema, batting)) throw new Error("잘못된 타격 조건");
      return getBattingStatistics(batting, signal);
    },
  });
  const pitch = useQuery({
    queryKey: ["statistics-pitching", pitching],
    enabled: kind === "pitching" && validPitching && scope.error === null,
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchingStatisticsQuerySchema, pitching))
        throw new Error("잘못된 투구 조건");
      return getPitchingStatistics(pitching, signal);
    },
  });
  const active = kind === "batting" ? bat : pitch;
  const valid = scope.error === null && (kind === "batting" ? validBatting : validPitching);
  function change(key: string, value: string) {
    const next = changeAnalysisParams(params, key, value);
    if (key !== "page") next.delete("page");
    if (key === "kind") {
      next.delete("sort");
      next.delete("minimum");
    }
    setParams(next);
  }
  const detail = (playerId: string) => {
    const query = new URLSearchParams(
      Object.entries({
        season,
        ...scope.options,
        [kind === "batting" ? "batter" : "pitcher"]: playerId,
      }).map(([k, v]) => [k, String(v)]),
    );
    return `/analysis/${kind === "batting" ? "batter-discipline" : "pitch-shape"}?${query}`;
  };
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>선수·팀 성적</h1>
          <p>
            선택한 수집 경기의 현재 기록을 합산합니다. 이적 선수는 경기 당시 팀별로 나눠 표시합니다.
          </p>
        </div>
      </header>
      <section className="panel pitch-analysis-toolbar" aria-label="성적 조건">
        <label>
          시즌
          <select
            aria-label="성적 시즌"
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
          성적 종류
          <select
            aria-label="성적 종류"
            value={kind}
            onChange={(e) => change("kind", e.target.value)}
          >
            <option value="batting">타격</option>
            <option value="pitching">투구</option>
          </select>
        </label>
        <label>
          집계
          <select
            aria-label="성적 집계"
            value={common.group}
            onChange={(e) => change("group", e.target.value)}
          >
            <option value="player">선수·당시 팀</option>
            <option value="team">팀</option>
          </select>
        </label>
        <label>
          최소 {kind === "batting" ? "타석" : "상대 타자"}
          <input
            aria-label="최소 표본"
            type="number"
            min="0"
            value={params.get("minimum") ?? "0"}
            onChange={(e) => change("minimum", e.target.value)}
          />
        </label>
        <label>
          정렬
          <select
            aria-label="성적 정렬"
            value={params.get("sort") ?? (kind === "batting" ? "ops" : "kMinusBbRate")}
            onChange={(e) => change("sort", e.target.value)}
          >
            {(kind === "batting"
              ? [
                  ["ops", "OPS"],
                  ["avg", "타율"],
                  ["plateAppearances", "타석"],
                  ["homeRuns", "홈런"],
                ]
              : [
                  ["kMinusBbRate", "K−BB%"],
                  ["era", "ERA"],
                  ["battersFaced", "상대 타자"],
                  ["outsRecorded", "이닝"],
                ]
            ).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>
      {!valid && <p role="alert">{scope.error ?? "조회 조건이 올바르지 않습니다."}</p>}
      {valid && active.isPending && <p role="status">성적을 합산하고 있습니다.</p>}
      {active.error && <p role="alert">{active.error.message}</p>}
      {valid && active.data && (
        <section className="panel">
          <p>
            {active.data.total}개 행 · 최소 표본은 탐색 조건이며 공식 규정 충족을 뜻하지 않습니다.
          </p>
          {kind === "batting" && bat.data && <BattingTable rows={bat.data.rows} detail={detail} />}
          {kind === "pitching" && pitch.data && (
            <PitchingTable rows={pitch.data.rows} detail={detail} />
          )}
          {active.data.total === 0 && (
            <p>
              선택 범위의 자료가 없습니다.{" "}
              <Link to={`/analysis/coverage?${analysisScopeSearch(season, scope.options)}`}>
                경기 분류와 수집 범위 확인
              </Link>
            </p>
          )}
          <nav aria-label="성적 페이지">
            <button
              disabled={common.page <= 1}
              onClick={() => change("page", String(common.page - 1))}
            >
              이전
            </button>
            <span>{common.page}쪽</span>
            <button
              disabled={common.page * 50 >= active.data.total}
              onClick={() => change("page", String(common.page + 1))}
            >
              다음
            </button>
          </nav>
          <p>
            비율의 분모가 0이면 —입니다. 볼넷은 고의4구를 포함합니다. 미제공 자책점은 0으로 채우지
            않습니다.
          </p>
        </section>
      )}
    </div>
  );
}
