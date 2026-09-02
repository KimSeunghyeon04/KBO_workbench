import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Side, StagingGameDocumentV2 } from "@kbo/contracts";

export type PlayerRole = "batter" | "pitcher" | "runner" | "responsible_pitcher";
export interface PlayerCandidate {
  readonly playerId: string;
  readonly name: string;
  readonly side: Side;
  readonly label: string;
  readonly searchText: string;
}
export interface PlayerPickerProps {
  readonly label: string;
  readonly document: StagingGameDocumentV2;
  readonly side: Side;
  readonly value: string;
  readonly onChange: (playerId: string) => void;
  readonly optionalLabel?: string;
  readonly helperText?: string | undefined;
  readonly prioritizedPlayerIds?: readonly (string | null | undefined)[];
  readonly allowedPlayerIds?: ReadonlySet<string>;
  readonly disabled?: boolean;
}

export function PlayerPicker({
  label,
  document,
  side,
  value,
  onChange,
  optionalLabel,
  helperText,
  prioritizedPlayerIds = [],
  allowedPlayerIds,
  disabled = false,
}: PlayerPickerProps): React.JSX.Element {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const candidates = useMemo(
    () =>
      playerCandidates(document, side, prioritizedPlayerIds).filter(
        (item) => allowedPlayerIds === undefined || allowedPlayerIds.has(item.playerId),
      ),
    [allowedPlayerIds, document, prioritizedPlayerIds, side],
  );
  const filtered = useMemo(() => {
    const text = normalize(query);
    return text === "" ? candidates : candidates.filter((item) => item.searchText.includes(text));
  }, [candidates, query]);
  const options: readonly (PlayerCandidate | null)[] =
    optionalLabel === undefined ? filtered : [null, ...filtered];
  const selected = candidates.find((item) => item.playerId === value);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const index = options.findIndex((item) => item?.playerId === value);
    setActive(index < 0 ? 0 : index);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const listener = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    globalThis.document.addEventListener("pointerdown", listener);
    return () => globalThis.document.removeEventListener("pointerdown", listener);
  }, [open]);
  const choose = (candidate: PlayerCandidate | null): void => {
    onChange(candidate?.playerId ?? "");
    setOpen(false);
    setQuery("");
    queueMicrotask(() => trigger.current?.focus());
  };
  const move = (amount: number): void => {
    if (options.length > 0)
      setActive((value) => (value + amount + options.length) % options.length);
  };
  return (
    <div className="player-picker" ref={root}>
      <span className="player-picker-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className={`player-picker-trigger ${selected === undefined && value !== "" ? "invalid" : ""}`}
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-controls={`${id}-listbox`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={selected === undefined && value !== ""}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>
          {selected?.label ??
            (value === "" ? (optionalLabel ?? "선수를 선택하세요") : `명단에 없는 선수 · ${value}`)}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {selected === undefined && value !== "" ? (
        <small className="player-picker-error">현재 경기 명단에서 다시 선택해야 합니다.</small>
      ) : null}
      {helperText === undefined ? null : <small className="auto-fill-hint">{helperText}</small>}
      {open ? (
        <div className="player-picker-panel">
          <input
            ref={search}
            type="search"
            value={query}
            aria-label={`${label} 검색`}
            aria-controls={`${id}-listbox`}
            aria-activedescendant={
              options.length === 0 ? undefined : `${id}-option-${String(active)}`
            }
            placeholder="선수명·ID·팀·포지션 검색"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const candidate = options[active];
                if (candidate !== undefined) choose(candidate);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          />
          <div id={`${id}-listbox`} className="player-picker-list" role="listbox">
            {options.length === 0 ? (
              <span className="player-picker-empty">검색 결과가 없습니다.</span>
            ) : (
              options.map((candidate, index) => (
                <button
                  id={`${id}-option-${String(index)}`}
                  key={candidate?.playerId ?? "optional"}
                  className={index === active ? "active" : ""}
                  type="button"
                  role="option"
                  aria-selected={(candidate?.playerId ?? "") === value}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(candidate)}
                >
                  {candidate?.label ?? optionalLabel ?? "선택 안 함"}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function playerCandidates(
  document: StagingGameDocumentV2,
  side: Side,
  prioritizedPlayerIds: readonly (string | null | undefined)[] = [],
): readonly PlayerCandidate[] {
  const priority = new Map(
    prioritizedPlayerIds.flatMap((id, index) =>
      id === null || id === undefined || id === "" ? [] : [[id, index] as const],
    ),
  );
  return document.rosters[side].players
    .map((player, index) => {
      const positions = player.positions.length === 0 ? "포지션 없음" : player.positions.join("/");
      const order = player.battingOrder === undefined ? "" : ` · ${String(player.battingOrder)}번`;
      const label = `${document.teams[side].name} · ${player.name}(${player.playerId}) · ${positions}${order}`;
      return {
        playerId: player.playerId,
        name: player.name,
        side,
        label,
        searchText: normalize(label),
        priority: priority.get(player.playerId) ?? Number.MAX_SAFE_INTEGER,
        index,
      };
    })
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => ({
      playerId: item.playerId,
      name: item.name,
      side: item.side,
      label: item.label,
      searchText: item.searchText,
    }));
}

export function playerSideForRole(half: "top" | "bottom", role: PlayerRole): Side {
  const attack: Side = half === "top" ? "away" : "home";
  return role === "batter" || role === "runner" ? attack : attack === "away" ? "home" : "away";
}
export function isRosterPlayerId(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string,
): boolean {
  return document.rosters[side].players.some((item) => item.playerId === playerId);
}
function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
}
