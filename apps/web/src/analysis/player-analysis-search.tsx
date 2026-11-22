import { useEffect, useId, useRef, useState } from "react";
import { filterAnalysisPlayers, type AnalysisCatalogPlayer } from "./player-analysis-navigation";

const resultLimit = 12;

export function PlayerAnalysisSearch({
  players,
  selectedId,
  unavailable,
  onSelect,
}: {
  players: readonly AnalysisCatalogPlayer[] | undefined;
  selectedId: string | null;
  unavailable: string;
  onSelect: (player: AnalysisCatalogPlayer) => void;
}) {
  const resultsId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const showResults = open && query.trim() !== "";
  const matches = showResults && players ? filterAnalysisPlayers(players, query) : [];

  useEffect(() => {
    if (!showResults) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [showResults]);

  function choose(player: AnalysisCatalogPlayer) {
    input.current?.focus();
    setOpen(false);
    setQuery("");
    if (player.id !== selectedId) onSelect(player);
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
        if (event.nativeEvent.isComposing) return;
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
          choose(matches[0]);
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
        placeholder="선수 이름 또는 ID"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      <div id={resultsId} className="player-analysis-search-results" hidden={!showResults}>
        {showResults &&
          (matches.length === 0 ? (
            <p role="status">
              {players === undefined
                ? unavailable
                : players.length === 0
                  ? "이 조회 범위에 검색할 선수가 없습니다."
                  : "일치하는 선수가 없습니다."}
            </p>
          ) : (
            <>
              <ul ref={results} aria-label="선수 검색 결과">
                {matches.slice(0, resultLimit).map((player) => (
                  <li key={player.id}>
                    <button
                      type="button"
                      aria-label={`${player.name} ID ${player.id}`}
                      aria-current={player.id === selectedId ? true : undefined}
                      onClick={() => choose(player)}
                    >
                      <strong>{player.name}</strong>
                      <span>ID {player.id}</span>
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
