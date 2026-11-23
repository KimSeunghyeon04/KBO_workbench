import { useId, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { playerBasicHref } from "../analysis/player-analysis-navigation";
import {
  filterDirectoryPlayers,
  playerBirthYearLabel,
  playerCareer,
  playerPosition,
  usePlayerDirectory,
} from "../analysis/player-directory";
import "../styles/analysis-workspace.css";
import "../styles/analysis-players.css";

const pageSize = 48;

export function AnalysisPlayersPage() {
  const idPrefix = useId();
  const [params, setParams] = useSearchParams();
  const directory = usePlayerDirectory();
  const search = params.get("q") ?? "";
  const matches = useMemo(
    () => filterDirectoryPlayers(directory.data ?? [], search),
    [directory.data, search],
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const requestedPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(1, Math.min(requestedPage, pageCount))
    : 1;

  function changeSearch(value: string) {
    setParams(value === "" ? {} : { q: value }, { replace: true });
  }

  function changePage(value: number) {
    const next = new URLSearchParams(params);
    next.set("page", String(value));
    setParams(next);
  }

  return (
    <div className="page-stack analysis-players-page">
      <header className="page-header">
        <div>
          <h1>선수 분석</h1>
        </div>
      </header>
      <section className="panel analysis-filter-bar" aria-label="선수 탐색">
        <div className="analysis-primary-filters">
          <label>
            선수 검색
            <input
              type="search"
              value={search}
              placeholder="전체 선수 이름 또는 ID"
              onChange={(event) => changeSearch(event.target.value)}
            />
          </label>
        </div>
      </section>
      {directory.error && (
        <section className="panel analysis-player-error" role="alert">
          <p>선수 목록을 읽지 못했습니다. {directory.error.message}</p>
          <button
            type="button"
            className="analysis-button"
            disabled={directory.isFetching}
            onClick={() => void directory.refetch()}
          >
            다시 시도
          </button>
        </section>
      )}
      {directory.isPending && directory.isFetching && (
        <p role="status">선수 목록을 읽고 있습니다.</p>
      )}
      {directory.data && (
        <>
          <div className="analysis-player-results-heading">
            <h2>선수 목록</h2>
            <p aria-live="polite" aria-atomic="true">
              검색 결과 {matches.length.toLocaleString()}명 · 전체{" "}
              {directory.data.length.toLocaleString()}명
            </p>
          </div>
          {directory.data.length === 0 ? (
            <p className="panel" role="status">
              분석할 선수 기록이 아직 없습니다.
            </p>
          ) : matches.length === 0 ? (
            <section className="panel analysis-player-empty" role="status">
              <h2>검색 결과가 없습니다</h2>
              <button type="button" className="analysis-button" onClick={() => changeSearch("")}>
                검색 초기화
              </button>
            </section>
          ) : (
            <>
              <ul className="analysis-player-list" aria-label="선수 목록">
                {matches.slice((page - 1) * pageSize, page * pageSize).map((player, index) => {
                  const season = player.seasons[0]?.season;
                  if (season === undefined) return null;
                  const { teams } = playerCareer(player);
                  return (
                    <li key={player.identity}>
                      <Link
                        to={playerBasicHref(player.identity, season)}
                        aria-label={`${player.name} 분석 보기`}
                        aria-describedby={`${idPrefix}-birth-${index} ${idPrefix}-position-${index} ${idPrefix}-teams-${index}`}
                      >
                        <span className="analysis-player-identity">
                          <span>
                            <strong>{player.name}</strong>
                            {" · "}
                            <small id={`${idPrefix}-birth-${index}`}>
                              {playerBirthYearLabel(player)}
                            </small>
                            {" · "}
                            <small id={`${idPrefix}-position-${index}`}>
                              {playerPosition(player)}
                            </small>
                          </span>
                          <small id={`${idPrefix}-teams-${index}`}>{teams}</small>
                        </span>
                        <svg
                          className="analysis-player-arrow"
                          viewBox="0 0 20 20"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {pageCount > 1 && (
                <div className="analysis-pagination" aria-label="선수 목록 페이지">
                  <button
                    type="button"
                    className="analysis-button"
                    disabled={page === 1}
                    onClick={() => changePage(page - 1)}
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
                    onClick={() => changePage(page + 1)}
                  >
                    다음 선수
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
