import { useQuery } from "@tanstack/react-query";
import { PlayerPeriodComparison } from "../analysis/player-period-comparison";
import { Value } from "@sinclair/typebox/value";
import {
  defaultAnalysisCompetition,
  PlayerSeasonStatisticsQuerySchema,
  type DisciplineCatalog,
  type PitchAnalysisCatalog,
} from "@kbo/contracts";
import { Link } from "react-router-dom";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { analysisScopeSearch } from "../analysis/analysis-scope";
import {
  AnalysisScopeFields,
  analysisScopeSummary,
  competitionLabels,
} from "../analysis/analysis-scope-fields";
import { analysisCatalogPlayers, selectedPlayerRole } from "../analysis/player-analysis-navigation";
import { findDirectoryPlayer, usePlayerDirectory } from "../analysis/player-directory";
import { PlayerSeasonRecords } from "../analysis/player-season-records";
import { PlayerLeagueComparison } from "../analysis/player-league-comparison";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getPlayerSeasonStatistics } from "../api/player-statistics-client";
import "../styles/analysis-workspace.css";

export function PlayerBasicStatisticsPage() {
  const { params, selected, season, scope, change } = useAnalysisScope();
  const role = selectedPlayerRole(params);
  const identity = params.get("player");
  const directory = usePlayerDirectory();
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof analysisCatalogPlayers>
  >({
    ...(role === "pitcher"
      ? pitcherCatalogQueryOptions(season, scope.options)
      : batterCatalogQueryOptions(season, scope.options)),
    enabled: identity === null && scope.error === null,
    select: analysisCatalogPlayers,
  });
  const sourceId = params.get(role) ?? catalog.data?.[0]?.id ?? null;
  const player = findDirectoryPlayer(directory.data, identity, sourceId);
  const playerKey = identity ?? player?.identity ?? sourceId;
  const record = player?.seasons.find((entry) => entry.season === season);
  const legacy = identity === null && player === undefined;
  const loading =
    identity === null && (sourceId === null ? catalog.isPending : directory.isPending);
  const selectionError = identity === null && sourceId === null ? catalog.error : null;
  const dateFiltered = scope.options.dateFrom !== undefined || scope.options.dateTo !== undefined;
  const competition = scope.options.competition ?? defaultAnalysisCompetition;
  const query = {
    player: playerKey ?? "",
    ...scope.options,
    ...(dateFiltered ? { season } : {}),
    ...(legacy ? { sourceRole: role } : {}),
  };
  const valid = Value.Check(PlayerSeasonStatisticsQuerySchema, query);
  const error =
    scope.error ?? (playerKey !== null && !valid ? "선수 조회 조건이 올바르지 않습니다." : null);
  const records = useQuery({
    queryKey: ["player-season-statistics", query],
    meta: { analysis: { seasons: dateFiltered ? [season] : "all", usesModels: false } },
    enabled: error === null && !loading && valid,
    queryFn: ({ signal }) => {
      if (!Value.Check(PlayerSeasonStatisticsQuerySchema, query))
        throw new Error("잘못된 기본 기록 조건");
      return getPlayerSeasonStatistics(query, signal);
    },
  });
  const data = records.data;
  const hasRecords = data !== undefined && (data.batting.length > 0 || data.pitching.length > 0);
  const summary = dateFiltered
    ? `${season} · ${analysisScopeSummary(selected)}`
    : `${competitionLabels[competition]} · 수집 경기 합계`;
  const battingId = legacy && role === "batter" ? sourceId : record?.battingPlayerId;
  const pitchingId = legacy && role === "pitcher" ? sourceId : record?.pitchingPlayerId;
  const comparisonRole =
    battingId && pitchingId
      ? params.get("comparisonRole") === "pitcher"
        ? "pitcher"
        : params.get("comparisonRole") === "batter" ||
            (identity !== null && !params.has("playerRole"))
          ? "batter"
          : role
      : battingId
        ? "batter"
        : "pitcher";
  const comparisonId = comparisonRole === "batter" ? battingId : pitchingId;
  return (
    <div className="page-stack player-basic-statistics-page">
      <header className="page-header player-season-heading">
        <h1>기본 기록</h1>
        {error === null && <p className="analysis-caption">연도별 성적 · {summary}</p>}
      </header>
      <details className="panel player-report-filters" aria-label="기본 기록 조건">
        <summary>
          <strong>조회 조건 변경</strong>
        </summary>
        <div className="player-report-filter-fields">
          <AnalysisScopeFields params={selected} onChange={change} />
        </div>
        <p className="analysis-caption">
          날짜를 지정하면 {season}년의 해당 기간 기록을 표시합니다.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {error === null && selectionError && (
        <div role="alert">
          <p>선수 목록을 읽지 못했습니다. {selectionError.message}</p>
          <button
            className="analysis-button"
            disabled={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            선수 목록 다시 시도
          </button>
        </div>
      )}
      {error === null && loading && <p role="status">선수 목록을 읽고 있습니다.</p>}
      {error === null && identity === null && !sourceId && catalog.isSuccess && (
        <AnalysisEmptyState season={season} options={scope.options} />
      )}
      {error === null && records.isFetching && <p role="status">기본 기록을 합산하고 있습니다.</p>}
      {error === null && records.error && (
        <div role="alert">
          <p>기본 기록을 읽지 못했습니다. {records.error.message}</p>
          <button
            className="analysis-button"
            disabled={records.isFetching}
            onClick={() => void records.refetch()}
          >
            기록 다시 시도
          </button>
        </div>
      )}
      {error === null && records.isSuccess && !hasRecords && (
        <p role="status" className="panel">
          선택한 범위에 이 선수의 기본 기록이 없습니다.{" "}
          <Link to={`/analysis/coverage?${analysisScopeSearch(season, scope.options)}`}>
            경기 분류와 수집 범위 확인
          </Link>
        </p>
      )}
      {error === null && hasRecords && <PlayerSeasonRecords {...data} />}
      {error === null && comparisonId && (
        <>
          {battingId && pitchingId && (
            <label className="player-basic-comparison-kind">
              비교 기록
              <select
                value={comparisonRole}
                onChange={(event) => change("comparisonRole", event.target.value)}
              >
                <option value="batter">타격</option>
                <option value="pitcher">투구</option>
              </select>
            </label>
          )}
          {playerKey && (
            <PlayerLeagueComparison
              query={{
                season,
                ...scope.options,
                role: comparisonRole,
                player: playerKey,
                ...(legacy ? { source: "naver" } : {}),
              }}
            />
          )}
          <PlayerPeriodComparison
            kind="statistics"
            query={{ season, ...scope.options }}
            playerId={comparisonId}
            role={comparisonRole}
          />
        </>
      )}
    </div>
  );
}
