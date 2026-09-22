import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { loadReplay } from "../api/client";
import { storedCatalogQueryOptions, revisionCatalogQueryOptions } from "../api/query-options";
import { catalogGameIdentity, catalogMonths, catalogSeasons, filterStoredGames } from "./catalog";
import { nextReplayIndex, replayDelay } from "./playback";

interface ReplaySelection {
  readonly gameId: string;
  readonly revision: number;
}

interface RevisionSelection {
  readonly gameId: string;
  readonly revision: number | null;
}

export function useReplayPageController() {
  const [searchParams] = useSearchParams();
  const requestedGameId = searchParams.get("gameId");
  const requestedRevision = parseRequestedRevision(searchParams.get("revision"));
  const games = useQuery(storedCatalogQueryOptions());
  const stored = useMemo(
    () => games.data?.games.filter((item) => item.authority === "database") ?? [],
    [games.data],
  );
  const [search, setSearch] = useState("");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(requestedGameId);
  const gameId = selectedGameId ?? stored[0]?.gameId ?? "";
  const [revisionSelection, setRevisionSelection] = useState<RevisionSelection | null>(
    requestedGameId === null || requestedRevision === null
      ? null
      : { gameId: requestedGameId, revision: requestedRevision },
  );
  const revisions = useQuery({
    ...revisionCatalogQueryOptions(gameId),
    enabled: gameId !== "",
  });
  const revision =
    revisionSelection !== null && revisionSelection.gameId === gameId
      ? revisionSelection.revision
      : (revisions.data?.currentRevision ?? null);
  const replay = useMutation({
    mutationFn: (selection: ReplaySelection) => loadReplay(selection.gameId, selection.revision),
  });
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [seasonFilter, setSeasonFilterState] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [requestedMonth, setRequestedMonth] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const seasons = useMemo(() => catalogSeasons(stored), [stored]);
  const calendarMonths = useMemo(() => catalogMonths(stored, seasonFilter), [seasonFilter, stored]);
  const selectedGame = stored.find((item) => item.gameId === gameId) ?? null;
  const selectedGameMonth =
    selectedGame === null ? null : catalogGameIdentity(selectedGame)?.isoDate.slice(0, 7);
  const fallbackMonth =
    selectedGameMonth !== null &&
    selectedGameMonth !== undefined &&
    calendarMonths.includes(selectedGameMonth)
      ? selectedGameMonth
      : (calendarMonths.at(-1) ?? "");
  const visibleMonth = calendarMonths.includes(requestedMonth) ? requestedMonth : fallbackMonth;
  const filteredGames = useMemo(
    () => filterStoredGames(stored, search, seasonFilter, selectedDate),
    [search, seasonFilter, selectedDate, stored],
  );

  useEffect(() => {
    if (!sourceOpen) return;
    searchInputRef.current?.focus();
  }, [sourceOpen]);

  const loadedReplay = replay.data;
  useEffect(() => {
    if (!playing || loadedReplay === undefined || loadedReplay.frames.length === 0) return;
    const timer = globalThis.setInterval(
      () =>
        setIndex((current) => {
          const next = nextReplayIndex(current, loadedReplay.frames.length);
          if (next === current) setPlaying(false);
          return next;
        }),
      replayDelay(speed),
    );
    return () => globalThis.clearInterval(timer);
  }, [loadedReplay, playing, speed]);

  function setGameId(nextGameId: string): void {
    setSelectedGameId(nextGameId);
    setRevisionSelection(null);
    setPlaying(false);
  }

  function setRevision(nextRevision: number | null): void {
    setRevisionSelection({ gameId, revision: nextRevision });
    setPlaying(false);
  }

  function setSeasonFilter(nextSeason: string): void {
    setSeasonFilterState(nextSeason);
    setSelectedDate(null);
    setRequestedMonth("");
  }

  function setVisibleMonth(nextMonth: string): void {
    setRequestedMonth(nextMonth);
    setSelectedDate(null);
  }

  function loadSelectedReplay(): void {
    if (gameId === "" || revision === null) return;
    replay.mutate(
      { gameId, revision },
      {
        onSuccess(data) {
          setIndex(data.frames.length === 0 ? -1 : 0);
          setSourceOpen(false);
        },
      },
    );
  }

  const frame = loadedReplay?.frames[index] ?? null;
  const state = frame?.after ?? loadedReplay?.manifest.finalState ?? null;

  return {
    games,
    stored,
    search,
    setSearch,
    gameId,
    setGameId,
    revision,
    setRevision,
    revisions,
    replay,
    index,
    setIndex,
    playing,
    setPlaying,
    speed,
    setSpeed,
    sourceOpen,
    setSourceOpen,
    seasonFilter,
    setSeasonFilter,
    selectedDate,
    setSelectedDate,
    visibleMonth,
    setVisibleMonth,
    searchInputRef,
    seasons,
    calendarMonths,
    filteredGames,
    selectedGame,
    loadedReplay,
    loadSelectedReplay,
    frame,
    state,
  };
}

function parseRequestedRevision(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
