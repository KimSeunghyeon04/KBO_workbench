import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { GameCatalogItem } from "@kbo/contracts";

import { useFixedVirtualList } from "../components/use-fixed-virtual-list";
import {
  calendarDays,
  catalogDateCounts,
  catalogGameIdentity,
  catalogGameTitle,
  formatCalendarDate,
  formatCalendarMonth,
} from "./catalog";

export function GamePicker({
  games,
  filteredGames,
  seasons,
  seasonFilter,
  calendarMonths,
  visibleMonth,
  selectedDate,
  search,
  searchInputRef,
  selectedGame,
  revision,
  revisions,
  loadingGames,
  loadingRevisions,
  loadingReplay,
  floating,
  onSearchChange,
  onSeasonChange,
  onMonthChange,
  onDateChange,
  onGameChange,
  onRevisionChange,
  onClose,
  onLoad,
}: {
  readonly games: readonly GameCatalogItem[];
  readonly filteredGames: readonly GameCatalogItem[];
  readonly seasons: readonly number[];
  readonly seasonFilter: string;
  readonly calendarMonths: readonly string[];
  readonly visibleMonth: string;
  readonly selectedDate: string | null;
  readonly search: string;
  readonly searchInputRef: React.RefObject<HTMLInputElement | null>;
  readonly selectedGame: GameCatalogItem | null;
  readonly revision: number | null;
  readonly revisions: readonly { readonly revision: number; readonly current: boolean }[];
  readonly loadingGames: boolean;
  readonly loadingRevisions: boolean;
  readonly loadingReplay: boolean;
  readonly floating: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onSeasonChange: (value: string) => void;
  readonly onMonthChange: (value: string) => void;
  readonly onDateChange: (value: string | null) => void;
  readonly onGameChange: (gameId: string) => void;
  readonly onRevisionChange: (revision: number | null) => void;
  readonly onClose: () => void;
  readonly onLoad: () => void;
}): React.JSX.Element {
  const selectedIndex = filteredGames.findIndex((game) => game.gameId === selectedGame?.gameId);
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);
  const virtualList = useFixedVirtualList({
    itemCount: filteredGames.length,
    rowHeight: 80,
    selectedIndex: filteredGames.length === 0 ? null : activeIndex,
    initialViewportHeight: 272,
  });
  useEffect(() => {
    if (filteredGames.length === 0) {
      setActiveIndex(0);
      return;
    }
    if (selectedIndex >= 0) setActiveIndex(selectedIndex);
    else setActiveIndex((current) => Math.min(current, filteredGames.length - 1));
  }, [filteredGames.length, selectedIndex]);
  const visibleGames = filteredGames.slice(virtualList.window.start, virtualList.window.end);
  const activeGame = filteredGames[activeIndex];

  const moveActiveGame = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (filteredGames.length === 0) return;
    if (event.key === "Enter" || event.key === " ") {
      if (activeGame !== undefined) {
        event.preventDefault();
        onGameChange(activeGame.gameId);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setActiveIndex((current) =>
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? filteredGames.length - 1
          : event.key === "ArrowDown"
            ? Math.min(filteredGames.length - 1, current + 1)
            : Math.max(0, current - 1),
    );
  };
  return (
    <div
      className={`replay-game-picker${floating ? " floating" : ""}`}
      aria-label="경기 선택"
      onKeyDown={(event) => {
        if (event.key === "Escape" && floating) {
          onClose();
        }
      }}
    >
      <div className="replay-game-picker-heading">
        <div>
          <strong>경기 선택</strong>
          <span>seal된 DB 경기만 표시합니다.</span>
        </div>
        <div className="replay-game-picker-heading-actions">
          <span className="replay-game-result-count" role="status" aria-live="polite">
            {loadingGames
              ? "목록 확인 중…"
              : `검색 결과 ${String(filteredGames.length)} / ${String(games.length)}`}
          </span>
          {floating ? (
            <button type="button" className="replay-game-picker-close" onClick={onClose}>
              <span aria-hidden="true">×</span>
              <span className="sr-only">경기 선택 닫기</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="replay-game-picker-filters">
        <label className="replay-game-search">
          <span>게임 ID 검색</span>
          <span className="replay-game-search-field">
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchInputRef}
              type="search"
              value={search}
              placeholder="게임 ID 또는 시즌"
              onChange={(event) => onSearchChange(event.target.value)}
            />
            {search === "" ? null : (
              <button
                type="button"
                aria-label="경기 검색어 지우기"
                onClick={() => onSearchChange("")}
              >
                ×
              </button>
            )}
          </span>
        </label>
        <div className="replay-season-filter" role="group" aria-label="시즌 필터">
          <button
            type="button"
            className={seasonFilter === "all" ? "selected" : ""}
            aria-pressed={seasonFilter === "all"}
            onClick={() => onSeasonChange("all")}
          >
            전체 <span>{String(games.length)}</span>
          </button>
          {seasons.map((season) => {
            const count = games.filter((game) => game.season === season).length;
            const value = String(season);
            return (
              <button
                key={season}
                type="button"
                className={seasonFilter === value ? "selected" : ""}
                aria-pressed={seasonFilter === value}
                onClick={() => onSeasonChange(value)}
              >
                {value} <span>{String(count)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="replay-game-browser">
        <GameCalendar
          games={games}
          seasonFilter={seasonFilter}
          months={calendarMonths}
          visibleMonth={visibleMonth}
          selectedDate={selectedDate}
          onMonthChange={onMonthChange}
          onDateChange={onDateChange}
        />
        <div className="replay-game-result-pane">
          <div className="replay-game-result-heading">
            <div>
              <span>경기 목록</span>
              <strong>
                {selectedDate === null ? "전체 날짜" : formatCalendarDate(selectedDate)}
              </strong>
            </div>
            {selectedDate === null ? null : (
              <button type="button" onClick={() => onDateChange(null)}>
                전체 날짜 보기
              </button>
            )}
          </div>
          <div
            ref={virtualList.containerRef}
            className="replay-game-results"
            role="listbox"
            tabIndex={0}
            aria-label="DB 경기 목록"
            aria-activedescendant={
              activeGame === undefined ? undefined : gameOptionId(activeGame.gameId)
            }
            onKeyDown={moveActiveGame}
            onScroll={virtualList.onScroll}
          >
            {filteredGames.length === 0 ? (
              <div className="replay-game-no-results" role="status">
                <strong>일치하는 경기가 없습니다.</strong>
                <span>날짜를 해제하거나 검색어·시즌을 바꿔 보세요.</span>
              </div>
            ) : (
              <div
                className="replay-game-results-spacer"
                style={{ height: virtualList.window.totalHeight }}
              >
                {visibleGames.map((game, offset) => {
                  const index = virtualList.window.start + offset;
                  return (
                    <GameResult
                      key={game.gameId}
                      game={game}
                      index={index}
                      total={filteredGames.length}
                      active={index === activeIndex}
                      selected={selectedGame?.gameId === game.gameId}
                      onSelect={() => {
                        setActiveIndex(index);
                        onGameChange(game.gameId);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="replay-game-picker-footer">
        <div className="replay-game-selection">
          <span>선택한 경기</span>
          {selectedGame === null ? (
            <strong>경기를 선택하세요.</strong>
          ) : (
            <strong>{catalogGameTitle(selectedGame)}</strong>
          )}
        </div>
        <label className="replay-revision-select">
          <span>{loadingRevisions ? "Revision 확인 중…" : "Revision"}</span>
          <select
            value={revision ?? ""}
            disabled={selectedGame === null || loadingRevisions}
            onChange={(event) =>
              onRevisionChange(event.target.value === "" ? null : Number(event.target.value))
            }
          >
            <option value="">revision 선택</option>
            {revisions.map((item) => (
              <option key={item.revision} value={item.revision}>
                {String(item.revision)}
                {item.current ? " · current" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-button replay-load-button"
          type="button"
          disabled={selectedGame === null || revision === null || loadingReplay}
          onClick={onLoad}
        >
          {loadingReplay ? "불러오는 중…" : "선택 경기 재생"}
        </button>
      </div>
    </div>
  );
}

function GameCalendar({
  games,
  seasonFilter,
  months,
  visibleMonth,
  selectedDate,
  onMonthChange,
  onDateChange,
}: {
  readonly games: readonly GameCatalogItem[];
  readonly seasonFilter: string;
  readonly months: readonly string[];
  readonly visibleMonth: string;
  readonly selectedDate: string | null;
  readonly onMonthChange: (value: string) => void;
  readonly onDateChange: (value: string | null) => void;
}): React.JSX.Element {
  const monthIndex = months.indexOf(visibleMonth);
  const dateCounts = useMemo(() => catalogDateCounts(games, seasonFilter), [games, seasonFilter]);
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth]);
  return (
    <section className="replay-calendar" aria-label="날짜로 경기 찾기">
      <div className="replay-calendar-heading">
        <div>
          <span>달력에서 찾기</span>
          <strong>{formatCalendarMonth(visibleMonth)}</strong>
        </div>
        <div>
          <button
            type="button"
            aria-label="이전 경기 월"
            disabled={monthIndex <= 0}
            onClick={() => {
              const previous = months[monthIndex - 1];
              if (previous !== undefined) onMonthChange(previous);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="다음 경기 월"
            disabled={monthIndex < 0 || monthIndex >= months.length - 1}
            onClick={() => {
              const next = months[monthIndex + 1];
              if (next !== undefined) onMonthChange(next);
            }}
          >
            ›
          </button>
        </div>
      </div>
      {visibleMonth === "" ? (
        <div className="replay-calendar-empty">
          <strong>달력에 표시할 날짜가 없습니다.</strong>
          <span>게임 ID 검색으로 경기를 찾으세요.</span>
        </div>
      ) : (
        <>
          <div className="replay-calendar-weekdays" aria-hidden="true">
            {KOREAN_WEEKDAYS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div
            className="replay-calendar-days"
            role="grid"
            aria-label={`${formatCalendarMonth(visibleMonth)} 경기 달력`}
          >
            {days.map((day, dayIndex) => {
              if (day === null) return <span key={`empty-${String(dayIndex)}`} />;
              const count = dateCounts.get(day.isoDate) ?? 0;
              const selected = selectedDate === day.isoDate;
              return (
                <button
                  key={day.isoDate}
                  type="button"
                  disabled={count === 0}
                  className={selected ? "selected" : ""}
                  aria-pressed={selected}
                  aria-label={`${formatCalendarDate(day.isoDate)}, 경기 ${String(count)}개`}
                  onClick={() => onDateChange(selected ? null : day.isoDate)}
                >
                  <span>{String(day.day)}</span>
                  {count === 0 ? null : <strong>{String(count)}</strong>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function GameResult({
  game,
  index,
  total,
  active,
  selected,
  onSelect,
}: {
  readonly game: GameCatalogItem;
  readonly index: number;
  readonly total: number;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const identity = catalogGameIdentity(game);
  return (
    <button
      id={gameOptionId(game.gameId)}
      type="button"
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={-1}
      className={`replay-game-result${selected ? " selected" : ""}${active ? " active" : ""}`}
      style={{ transform: `translateY(${String(index * 80)}px)` }}
      onClick={onSelect}
    >
      <span className="replay-game-result-visual">
        {identity === null ? (
          <strong>{game.season ?? "—"}</strong>
        ) : (
          <>
            <small>{identity.date}</small>
            <strong>
              {identity.away} <i>vs</i> {identity.home}
            </strong>
          </>
        )}
      </span>
      <span className="replay-game-result-copy">
        <strong>{game.gameId}</strong>
        <small>
          {game.season === null ? "시즌 미상" : `${String(game.season)} 시즌`}
          {game.warningFindings > 0 ? ` · 경고 ${String(game.warningFindings)}` : ""}
        </small>
      </span>
      <span className="replay-game-result-check" aria-hidden="true">
        {selected ? "✓" : "›"}
      </span>
    </button>
  );
}

const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function gameOptionId(gameId: string): string {
  return `replay-game-option-${gameId}`;
}
