import { useEffect, useId, useRef, useState } from "react";
import type { PlayerDirectoryEntry } from "@kbo/contracts";
import {
  filterDirectoryPlayers,
  playerBirthYearLabel,
  playerCareer,
  playerPosition,
} from "./player-directory";
import { usePlayerSearchInput } from "./use-player-search-input";

const resultLimit = 12;

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
  const showResults = open && query.trim() !== "";
  const matches = showResults && players ? filterDirectoryPlayers(players, query) : [];

  useEffect(() => {
    if (!showResults) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [showResults]);

  function choose(player: PlayerDirectoryEntry) {
    input.current?.focus();
    setOpen(false);
    setQuery("");
    if (player.identity !== selectedId) onSelect(player);
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
          if (query.trim() !== "") {
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
        aria-label="선수 검색"
        aria-controls={resultsId}
        placeholder="전체 선수 이름 또는 ID"
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
              <ul ref={results} aria-label="선수 검색 결과">
                {matches.slice(0, resultLimit).map((player) => {
                  const { teams } = playerCareer(player);
                  const birthYear = playerBirthYearLabel(player);
                  const position = playerPosition(player);
                  return (
                    <li key={player.identity}>
                      <button
                        type="button"
                        aria-label={`${player.name}, ${birthYear}, ${position}, ${teams}`}
                        aria-current={player.identity === selectedId ? true : undefined}
                        onClick={() => choose(player)}
                      >
                        <span className="player-search-result-name">
                          <strong>{player.name}</strong> · {birthYear} · {position}
                        </span>
                        <span className="player-search-result-teams">{teams}</span>
                      </button>
                    </li>
                  );
                })}
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
