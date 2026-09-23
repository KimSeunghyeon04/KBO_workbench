import { useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { DisciplineCatalog, PitchAnalysisCatalog } from "@kbo/contracts";
import { AnalysisEmptyState } from "../analysis/analysis-empty-state";
import { AnalysisFilterBar } from "../analysis/analysis-filter-bar";
import { changeAnalysisParams, scopeFromParams } from "../analysis/analysis-scope";
import { AnalysisScopeFields, analysisScopeSummary } from "../analysis/analysis-scope-fields";
import {
  analysisCatalogPlayers,
  playerAnalysisHref,
  type PlayerAnalysisRole,
} from "../analysis/player-analysis-navigation";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../api/analysis-catalog-query-options";
import "../styles/analysis-workspace.css";
import "../styles/analysis-players.css";

const pageSize = 48;

export function AnalysisPlayersPage() {
  const idPrefix = useId();
  const [params, setParams] = useSearchParams();
  const season = Number(params.get("season") ?? 2025);
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const scope = scopeFromParams(season, selected);
  const error =
    scope.error ?? (season >= 2020 && season <= 2025 ? null : "2020~2025 시즌을 선택해 주세요.");
  const role: PlayerAnalysisRole = params.get("role") === "batter" ? "batter" : "pitcher";
  const roleLabel = role === "pitcher" ? "투수" : "타자";
  const search = params.get("q") ?? "";
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof analysisCatalogPlayers>
  >({
    ...(role === "pitcher"
      ? pitcherCatalogQueryOptions(season, scope.options)
      : batterCatalogQueryOptions(season, scope.options)),
    enabled: error === null,
    select: analysisCatalogPlayers,
  });
  const matches = useMemo(() => {
    const needle = search.trim().normalize("NFC").toLowerCase();
    return (
      catalog.data?.filter(
        (player) =>
          player.name.normalize("NFC").toLowerCase().includes(needle) ||
          player.id.normalize("NFC").toLowerCase().includes(needle),
      ) ?? []
    );
  }, [catalog.data, search]);
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const requestedPage = Number(params.get("page") ?? 1);
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage >= 1
      ? Math.min(requestedPage, pageCount)
      : 1;

  function change(key: string, value: string) {
    const next = changeAnalysisParams(params, key, value);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: key === "q" });
  }

  return (
    <div className="page-stack analysis-players-page">
      <header className="page-header">
        <div>
          <span className="analysis-kicker">PLAYER ANALYSIS</span>
          <h1>선수 분석</h1>
          <p>선수를 선택하고 코스, 구질, 변화와 경기 기록을 이어서 살펴보세요.</p>
        </div>
      </header>
      <AnalysisFilterBar
        label="선수 탐색 조건"
        summary={analysisScopeSummary(selected)}
        advanced={<AnalysisScopeFields params={selected} onChange={change} />}
      >
        <label>
          시즌
          <select
            aria-label="선수 분석 시즌"
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
        <div className="analysis-player-role" role="group" aria-label="선수 유형">
          <span>선수 유형</span>
          <div>
            {(["pitcher", "batter"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="analysis-button"
                aria-pressed={role === value}
                onClick={() => change("role", value)}
              >
                {value === "pitcher" ? "투수" : "타자"}
              </button>
            ))}
          </div>
        </div>
        <label className="analysis-player-search">
          선수 검색
          <input
            type="search"
            value={search}
            placeholder="이름 또는 선수 ID"
            onChange={(event) => change("q", event.target.value)}
          />
        </label>
      </AnalysisFilterBar>
      {error && <p role="alert">{error}</p>}
      {error === null && catalog.error && (
        <section className="panel analysis-player-error" role="alert">
          <p>선수 목록을 읽지 못했습니다. {catalog.error.message}</p>
          <button
            type="button"
            className="analysis-button"
            disabled={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            다시 시도
          </button>
        </section>
      )}
      {error === null && catalog.isFetching && <p role="status">선수 목록을 읽고 있습니다.</p>}
      {error === null && catalog.data && (
        <>
          <div className="analysis-player-results-heading">
            <div>
              <h2>{roleLabel} 목록</h2>
              <p aria-live="polite" aria-atomic="true">
                검색 결과 {matches.length.toLocaleString()}명 · 전체{" "}
                {catalog.data.length.toLocaleString()}명
              </p>
            </div>
            <span>수집 경기의 실제 투구 수 순</span>
          </div>
          {catalog.data.length === 0 ? (
            <AnalysisEmptyState season={season} options={scope.options} />
          ) : matches.length === 0 ? (
            <section className="panel analysis-player-empty" role="status">
              <h2>검색 결과가 없습니다</h2>
              <p>다른 이름이나 선수 ID로 검색해 보세요.</p>
              <button type="button" className="analysis-button" onClick={() => change("q", "")}>
                검색 초기화
              </button>
            </section>
          ) : (
            <>
              <ul className="analysis-player-list" aria-label={`${roleLabel} 목록`}>
                {matches.slice((page - 1) * pageSize, page * pageSize).map((player, index) => (
                  <li key={player.id}>
                    <Link
                      to={playerAnalysisHref(
                        role === "pitcher"
                          ? "/analysis/pitch-location"
                          : "/analysis/batter-profile",
                        role,
                        player.id,
                        season,
                        scope.options,
                      )}
                      aria-label={`${player.name} 분석 보기`}
                      aria-describedby={`${idPrefix}-player-${index}`}
                    >
                      <span className="analysis-player-identity">
                        <strong>{player.name}</strong>
                        <small id={`${idPrefix}-player-${index}`}>ID {player.id}</small>
                      </span>
                      <span className="analysis-player-pitches">
                        <strong>{player.pitches.toLocaleString()}구</strong>
                        <small>{role === "pitcher" ? "투구" : "상대 투구"}</small>
                      </span>
                      <span className="analysis-player-arrow" aria-hidden="true">
                        ↗
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="analysis-pagination" aria-label="선수 목록 페이지">
                <button
                  type="button"
                  className="analysis-button"
                  disabled={page === 1}
                  onClick={() => change("page", String(page - 1))}
                >
                  이전 선수
                </button>
                <span>
                  {page} / {pageCount}
                </span>
                <button
                  type="button"
                  className="analysis-button"
                  disabled={page === pageCount}
                  onClick={() => change("page", String(page + 1))}
                >
                  다음 선수
                </button>
              </div>
            </>
          )}
          <p className="analysis-caption analysis-player-catalog-note">
            선택한 범위에서 실제 투구가 기록된 선수입니다. 투구 수는 수집된 기록 기준이며, 분석별
            좌표·결과 표본 수는 다를 수 있습니다.
          </p>
        </>
      )}
    </div>
  );
}
