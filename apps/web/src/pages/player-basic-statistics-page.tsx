import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PlayerPeriodComparison } from "../analysis/player-period-comparison";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  type DisciplineCatalog,
  type PitchAnalysisCatalog,
} from "@kbo/contracts";
import { Link } from "react-router-dom";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { analysisScopeSearch } from "../analysis/analysis-scope";
import { AnalysisScopeFields, analysisScopeSummary } from "../analysis/analysis-scope-fields";
import { analysisCatalogPlayers, selectedPlayerRole } from "../analysis/player-analysis-navigation";
import { findDirectoryPlayer, usePlayerDirectory } from "../analysis/player-directory";
import { BattingTable, PitchingTable } from "../analysis/player-statistics-tables";
import { BattingRecordSummary, PitchingRecordSummary } from "../analysis/player-record-summary";
import { useAnalysisScope } from "../analysis/use-analysis-scope";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import { getBattingStatistics, getPitchingStatistics } from "../api/player-statistics-client";
import "../styles/analysis-workspace.css";
import "../styles/player-basic-statistics.css";

function BasicRecords({
  label,
  total,
  count,
  children,
  details,
}: {
  label: string;
  total: number;
  count: number;
  children: ReactNode;
  details: ReactNode;
}) {
  return (
    <section className="panel player-basic-records" aria-label={`${label} 기본 기록`}>
      {children}
      <details className="player-report-details">
        <summary>
          <strong>상세 기록</strong>
          <span>{label} 집계와 기록 해석</span>
        </summary>
        <div className="player-report-detail-content">
          {details}
          <p className="analysis-caption">
            비율의 분모가 0이면 —입니다. 볼넷은 고의4구를 포함하며 괄호 안에 고의4구를 표시합니다.
            미제공 자책점은 0으로 채우지 않습니다.
          </p>
        </div>
      </details>
      {total > count && (
        <p>
          전체 {total}개 팀별 기록 중 처음 {count}개를 표시합니다. 기간을 좁혀 나머지 기록을
          확인하세요.
        </p>
      )}
    </section>
  );
}

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
  const record = player?.seasons.find((entry) => entry.season === season);
  const legacy = identity === null && player === undefined;
  const battingId = legacy && role === "batter" ? sourceId : record?.battingPlayerId;
  const pitchingId = legacy && role === "pitcher" ? sourceId : record?.pitchingPlayerId;
  const common = { season, ...scope.options, group: "player", page: 1, limit: 200 };
  const battingQuery = { ...common, playerId: battingId ?? "" };
  const pitchingQuery = { ...common, playerId: pitchingId ?? "" };
  const validBatting = Value.Check(BattingStatisticsQuerySchema, battingQuery);
  const validPitching = Value.Check(PitchingStatisticsQuerySchema, pitchingQuery);
  const bat = useQuery({
    queryKey: ["statistics-batting", battingQuery],
    meta: analysisQueryMeta(battingQuery),
    enabled: scope.error === null && !!battingId && validBatting,
    queryFn: ({ signal }) => {
      if (!Value.Check(BattingStatisticsQuerySchema, battingQuery))
        throw new Error("잘못된 타격 조건");
      return getBattingStatistics(battingQuery, signal);
    },
  });
  const pitch = useQuery({
    queryKey: ["statistics-pitching", pitchingQuery],
    meta: analysisQueryMeta(pitchingQuery),
    enabled: scope.error === null && !!pitchingId && validPitching,
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchingStatisticsQuerySchema, pitchingQuery))
        throw new Error("잘못된 투구 조건");
      return getPitchingStatistics(pitchingQuery, signal);
    },
  });
  const active = [...(battingId ? [bat] : []), ...(pitchingId ? [pitch] : [])];
  const failed = active.find((entry) => entry.error !== null);
  const loading = identity ? directory.isPending : !sourceId && catalog.isPending;
  const selectionError = identity ? directory.error : !sourceId ? catalog.error : null;
  const error =
    scope.error ??
    ((battingId && !validBatting) || (pitchingId && !validPitching)
      ? "선수 조회 조건이 올바르지 않습니다."
      : null);
  const comparisonRole =
    battingId && pitchingId
      ? params.get("comparisonRole") === "pitcher"
        ? "pitcher"
        : params.get("comparisonRole") === "batter" || identity !== null
          ? "batter"
          : role
      : battingId
        ? "batter"
        : "pitcher";
  const comparisonId = comparisonRole === "batter" ? battingId : pitchingId;
  return (
    <div className="page-stack player-basic-statistics-page">
      <header className="page-header">
        <div>
          <h1>기본 기록</h1>
          <p>선택한 선수의 수집 경기 기록입니다. 이적 전후 기록은 팀별로 구분합니다.</p>
        </div>
      </header>
      <details className="panel player-report-filters" aria-label="기본 기록 조건">
        <summary>
          <strong>조회 조건 변경</strong>
          <span>
            {season} · {analysisScopeSummary(selected)}
          </span>
        </summary>
        <div className="player-report-filter-fields">
          <AnalysisScopeFields params={selected} onChange={change} />
        </div>
        <p className="analysis-caption">
          시즌·경기 종류·기간에 해당하는 전체 기록이며, 구종·카운트·코스 조건은 적용하지 않습니다.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
      {error === null && selectionError && (
        <div role="alert">
          <p>선수 목록을 읽지 못했습니다. {selectionError.message}</p>
          <button
            className="analysis-button"
            disabled={identity !== null ? directory.isFetching : catalog.isFetching}
            onClick={() => void (identity !== null ? directory.refetch() : catalog.refetch())}
          >
            선수 목록 다시 시도
          </button>
        </div>
      )}
      {error === null && loading && <p role="status">선수 목록을 읽고 있습니다.</p>}
      {error === null && identity === null && !sourceId && catalog.isSuccess && (
        <AnalysisEmptyState season={season} options={scope.options} />
      )}
      {error === null && active.some((entry) => entry.isFetching) && (
        <p role="status">기본 기록을 합산하고 있습니다.</p>
      )}
      {error === null && failed?.error && (
        <div role="alert">
          <p>기본 기록을 읽지 못했습니다. {failed.error.message}</p>
          <button
            className="analysis-button"
            disabled={failed.isFetching}
            onClick={() => void failed.refetch()}
          >
            기록 다시 시도
          </button>
        </div>
      )}
      {error === null &&
        !loading &&
        !selectionError &&
        (identity || sourceId) &&
        active.every((entry) => entry.isSuccess && entry.data.total === 0) && (
          <p role="status" className="panel">
            선택한 범위에 이 선수의 기본 기록이 없습니다.{" "}
            <Link to={`/analysis/coverage?${analysisScopeSearch(season, scope.options)}`}>
              경기 분류와 수집 범위 확인
            </Link>
          </p>
        )}
      {error === null && (
        <div className="player-basic-record-groups">
          {battingId && bat.data && bat.data.total > 0 && (
            <BasicRecords
              label="타자"
              total={bat.data.total}
              count={bat.data.rows.length}
              details={<BattingTable rows={bat.data.rows} view="basic" />}
            >
              <BattingRecordSummary rows={bat.data.rows} />
            </BasicRecords>
          )}
          {pitchingId && pitch.data && pitch.data.total > 0 && (
            <BasicRecords
              label="투수"
              total={pitch.data.total}
              count={pitch.data.rows.length}
              details={<PitchingTable rows={pitch.data.rows} view="basic" />}
            >
              <PitchingRecordSummary rows={pitch.data.rows} />
            </BasicRecords>
          )}
        </div>
      )}
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
