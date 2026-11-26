import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PlayerDirectoryEntry } from "@kbo/contracts";
import {
  normalizePlayerSearch,
  playerBirthYearLabel,
  playerCareer,
  playerPosition,
} from "./player-directory";
import { usePlayerSearchInput } from "./use-player-search-input";

const resultLimit = 12;

export interface PlayerSearchOption {
  id: string;
  name: string;
  summary?: string;
  details: string;
  accessibleName: string;
  searchTerms: readonly string[];
}

export function reportPlayerOption(
  id: string,
  name: string,
  teams: readonly string[],
  summary?: string,
): PlayerSearchOption {
  const details = (teams.join(" · ") || "팀 미확인") + " · ID " + id;
  return {
    id,
    name,
    details,
    ...(summary === undefined ? {} : { summary }),
    accessibleName: [name, details, summary].filter(Boolean).join(", "),
    searchTerms: [id, ...teams],
  };
}

export function PlayerSearch({
  players,
  selectedId,
  unavailable,
  retry,
  onSelect,
  label = "선수 검색",
  placeholder = "전체 선수 이름 또는 ID",
  suggestOnFocus = false,
}: {
  players: readonly PlayerSearchOption[] | undefined;
  selectedId: string | null;
  unavailable: string;
  retry?: (() => void) | undefined;
  onSelect: (id: string) => void;
  label?: string;
  placeholder?: string;
  suggestOnFocus?: boolean;
}) {
  const resultsId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { isComposing, inputProps } = usePlayerSearchInput(query, (value) => {
    setQuery(value);
    setOpen(true);
  });
  const needle = normalizePlayerSearch(query);
  const showResults = open && (suggestOnFocus || needle !== "");
  const matches =
    showResults && players
      ? players.filter(({ name, searchTerms }) =>
          [name, ...searchTerms].some((term) => normalizePlayerSearch(term).includes(needle)),
        )
      : [];

  useEffect(() => {
    if (!showResults) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [showResults]);

  function choose(player: PlayerSearchOption) {
    input.current?.focus();
    setOpen(false);
    setQuery("");
    if (player.id !== selectedId) onSelect(player.id);
  }

  return (
    <div
      className="player-analysis-search"
      ref={root}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (isComposing.current || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" && event.target === input.current && !showResults) {
          if (suggestOnFocus || needle !== "") {
            event.preventDefault();
            setOpen(true);
          }
          return;
        }
        if (!showResults) return;
        if (event.key === "Escape") {
          event.preventDefault();
          input.current?.focus();
          setOpen(false);
          return;
        }
        if (event.key === "Enter" && event.target === input.current && matches[0]) {
          event.preventDefault();
          if (matches.length === 1) choose(matches[0]);
          else results.current?.querySelector("button")?.focus();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const options = Array.from(results.current?.querySelectorAll("button") ?? []);
        const active = options.findIndex((button) => button === event.target);
        if (event.key === "ArrowUp" && active < 0) return;
        const next =
          event.key === "ArrowDown"
            ? options[Math.min(active + 1, options.length - 1)]
            : (options[active - 1] ?? input.current);
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      <svg
        className="player-analysis-search-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        ref={input}
        type="search"
        aria-label={label}
        aria-controls={resultsId}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        {...inputProps}
      />
      <div id={resultsId} className="player-analysis-search-results" hidden={!showResults}>
        {showResults &&
          (matches.length === 0 ? (
            <>
              <p role="status">
                {players === undefined
                  ? unavailable
                  : players.length === 0
                    ? "검색할 선수가 없습니다."
                    : "일치하는 선수가 없습니다."}
              </p>
              {players === undefined && retry && (
                <button type="button" className="analysis-button" onClick={retry}>
                  다시 시도
                </button>
              )}
            </>
          ) : (
            <>
              <ul ref={results} aria-label={label + " 결과"}>
                {matches.slice(0, resultLimit).map((player) => (
                  <li key={player.id}>
                    <button
                      type="button"
                      aria-label={player.accessibleName}
                      aria-current={player.id === selectedId ? true : undefined}
                      onClick={() => choose(player)}
                    >
                      <span className="player-search-result-name">
                        <strong>{player.name}</strong>
                        {player.summary && <> · {player.summary}</>}
                      </span>
                      <span className="player-search-result-teams">{player.details}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {matches.length > resultLimit && (
                <p role="status">검색 결과 {matches.length}명. 이름 또는 ID를 더 입력해 주세요.</p>
              )}
            </>
          ))}
      </div>
    </div>
  );
}

export function PlayerAnalysisSearch({
  players,
  selectedId,
  unavailable,
  retry,
  onSelect,
}: {
  players: readonly PlayerDirectoryEntry[] | undefined;
  selectedId: string | null;
  unavailable: string;
  retry: (() => void) | undefined;
  onSelect: (player: PlayerDirectoryEntry) => void;
}) {
  const options = useMemo(
    () =>
      players?.map((player) => {
        const { teams } = playerCareer(player);
        const birthYear = playerBirthYearLabel(player);
        const position = playerPosition(player);
        return {
          id: player.identity,
          name: player.name,
          summary: birthYear + " · " + position,
          details: teams,
          accessibleName: [player.name, birthYear, position, teams].join(", "),
          searchTerms: player.sourceIds,
        };
      }),
    [players],
  );
  return (
    <PlayerSearch
      players={options}
      selectedId={selectedId}
      unavailable={unavailable}
      retry={retry}
      onSelect={(id) => {
        const player = players?.find(({ identity }) => identity === id);
        if (player) onSelect(player);
      }}
    />
  );
}
