import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  type DisciplineCatalog,
  type PitchAnalysisCatalog,
} from "@kbo/contracts";
import { Link } from "react-router-dom";
import { AnalysisFilterBar } from "../analysis/analysis-filter-bar";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { analysisScopeSearch } from "../analysis/analysis-scope";
import { AnalysisScopeFields, analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { analysisCatalogPlayers } from "../analysis/player-analysis-navigation";
import { BattingTable, PitchingTable } from "../analysis/player-statistics-tables";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getBattingStatistics, getPitchingStatistics } from "../api/player-statistics-client";
import "../styles/analysis-workspace.css";

export function PlayerBasicStatisticsPage() {
  const { params, selected, season, scope, change } = useAnalysisScope();
  const role = params.get("playerRole") === "batter" ? "batter" : "pitcher";
  const roleLabel = role === "pitcher" ? "투수" : "타자";
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof analysisCatalogPlayers>
  >({
    ...(role === "pitcher"
      ? pitcherCatalogQueryOptions(season, scope.options)
      : batterCatalogQueryOptions(season, scope.options)),
    enabled: scope.error === null,
    select: analysisCatalogPlayers,
  });
  const playerId = params.get(role) ?? catalog.data?.[0]?.id ?? "";
  const query = { season, ...scope.options, playerId, group: "player", page: 1, limit: 200 };
  const validBatting = Value.Check(BattingStatisticsQuerySchema, query);
  const validPitching = Value.Check(PitchingStatisticsQuerySchema, query);
  const bat = useQuery({
    queryKey: ["statistics-batting", query],
    enabled: role === "batter" && scope.error === null && validBatting,
    queryFn: ({ signal }) => {
      if (!Value.Check(BattingStatisticsQuerySchema, query)) throw new Error("잘못된 타격 조건");
      return getBattingStatistics(query, signal);
    },
  });
  const pitch = useQuery({
    queryKey: ["statistics-pitching", query],
    enabled: role === "pitcher" && scope.error === null && validPitching,
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchingStatisticsQuerySchema, query)) throw new Error("잘못된 투구 조건");
      return getPitchingStatistics(query, signal);
    },
  });
  const active = role === "pitcher" ? pitch : bat;
  const error =
    scope.error ??
    (playerId && !(role === "pitcher" ? validPitching : validBatting)
      ? "선수 조회 조건이 올바르지 않습니다."
      : null);
  const missingCatalogPlayer =
    playerId !== "" && !catalog.data?.some((player) => player.id === playerId);

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <span className="analysis-kicker">PLAYER STATISTICS</span>
          <h1>기본 기록</h1>
          <p>선택한 선수의 수집 경기 기록입니다. 이적 전후 기록은 경기 당시 팀별로 표시합니다.</p>
        </div>
      </header>
      <AnalysisFilterBar
        label="기본 기록 조건"
        summary={analysisScopeSummary(selected)}
        advanced={<AnalysisScopeFields params={selected} onChange={change} />}
      >
        <label>
          시즌
          <select
            aria-label="성적 시즌"
            value={season}
            onChange={(event) => change("season", event.target.value)}
          >
            {[2020, 2021, 2022, 2023, 2024, 2025].map((year) => (
              <option key={year}>{year}</option>
            ))}
          </select>
        </label>
        <label>
          {roleLabel}
          <select
            aria-label={roleLabel}
            value={playerId}
            onChange={(event) => change(role, event.target.value)}
          >
            {!playerId && <option value="">선수를 선택하세요</option>}
            {missingCatalogPlayer && <option value={playerId}>선수 {playerId}</option>}
            {catalog.data?.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name} · {player.id}
              </option>
            ))}
          </select>
        </label>
      </AnalysisFilterBar>
      <p className="analysis-caption">
        시즌·경기 종류·기간에 해당하는 전체 기록이며, 구종·카운트·코스 조건은 적용하지 않습니다.
        선수 목록은 이 범위에서 실제 투구가 기록된 선수입니다.
      </p>
      {error && <p role="alert">{error}</p>}
      {error === null && catalog.error && (
        <div role="alert">
          <p>선수 목록을 읽지 못했습니다. {catalog.error.message}</p>
          <button
            className="analysis-button"
            disabled={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            선수 목록 다시 시도
          </button>
        </div>
      )}
      {error === null && catalog.isPending && catalog.isFetching && (
        <p role="status">선수 목록을 읽고 있습니다.</p>
      )}
      {error === null && !playerId && catalog.isSuccess && (
        <AnalysisEmptyState season={season} options={scope.options} />
      )}
      {error === null && playerId && active.isFetching && (
        <p role="status">기본 기록을 합산하고 있습니다.</p>
      )}
      {error === null && active.error && (
        <div role="alert">
          <p>기본 기록을 읽지 못했습니다. {active.error.message}</p>
          <button
            className="analysis-button"
            disabled={active.isFetching}
            onClick={() => void active.refetch()}
          >
            기록 다시 시도
          </button>
        </div>
      )}
      {error === null && active.isSuccess && active.data && (
        <section className="panel" aria-label={`${roleLabel} 기본 기록`}>
          {active.data.total === 0 ? (
            <p role="status">
              선택한 범위에 이 선수의 기본 기록이 없습니다.{" "}
              <Link to={`/analysis/coverage?${analysisScopeSearch(season, scope.options)}`}>
                경기 분류와 수집 범위 확인
              </Link>
            </p>
          ) : (
            <>
              {role === "batter" && bat.data && <BattingTable rows={bat.data.rows} basic />}
              {role === "pitcher" && pitch.data && <PitchingTable rows={pitch.data.rows} basic />}
              {active.data.total > active.data.rows.length && (
                <p>
                  전체 {active.data.total}개 팀별 기록 중 처음 {active.data.rows.length}개를
                  표시합니다. 기간을 좁혀 나머지 기록을 확인하세요.
                </p>
              )}
              <p className="analysis-caption">
                비율의 분모가 0이면 —입니다. 볼넷은 고의4구를 포함하며 괄호 안에 고의4구를
                표시합니다. 미제공 자책점은 0으로 채우지 않습니다.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
