import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { loadReplay } from "../api/client";
import type { LoadedReplay } from "../api/replay-client";
import { storedCatalogQueryOptions, revisionCatalogQueryOptions } from "../api/query-options";
import { catalogGameIdentity, catalogMonths, catalogSeasons, filterStoredGames } from "./catalog";
import { nextReplayIndex, replayDelay } from "./playback";
import {
  readReplayEvidenceTarget,
  replayEvidenceIndex,
  replayEvidenceLabels,
  type ReplayEvidenceTarget,
} from "./evidence-target";

interface ReplaySelection {
  readonly gameId: string;
  readonly revision: number;
  readonly target: ReplayEvidenceTarget | null;
}

interface RevisionSelection {
  readonly gameId: string;
  readonly revision: number | null;
}

export function useReplayPageController() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedGameId = searchParams.get("gameId");
  const requestedRevision = parseRequestedRevision(searchParams.get("revision"));
  const evidenceTarget = useMemo(() => readReplayEvidenceTarget(searchParams), [searchParams]);
  const autoLoaded = useRef<string | null>(null);
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null);
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
    mutationFn: (selection: ReplaySelection) =>
      queryClient.fetchQuery({
        queryKey: ["verified-replay", selection.gameId, selection.revision],
        queryFn: () => loadReplay(selection.gameId, selection.revision),
        staleTime: Infinity,
        retry: false,
      }),
  });
  const selectLoadedEvidence = useCallback((data: LoadedReplay, selection: ReplaySelection) => {
    const targetIndex =
      selection.target === null ? -1 : replayEvidenceIndex(data.frames, selection.target);
    setIndex(targetIndex >= 0 ? targetIndex : data.frames.length === 0 ? -1 : 0);
    setEvidenceNotice(
      selection.target === null
        ? null
        : targetIndex >= 0
          ? `분석에서 선택한 ${replayEvidenceLabels[selection.target.kind]} 장면을 열었습니다.`
          : "이 경기 버전에서 요청한 근거 장면을 찾지 못했습니다. 경기 처음을 표시합니다.",
    );
    setPlaying(false);
    setSourceOpen(false);
  }, []);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [seasonFilter, setSeasonFilterState] = useState<string>("all");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [requestedMonth, setRequestedMonth] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { mutate: load } = replay;
  useEffect(() => {
    if (!requestedGameId || requestedRevision === null || evidenceTarget === null) return;
    const key = JSON.stringify([requestedGameId, requestedRevision, evidenceTarget]);
    if (autoLoaded.current === key) return;
    autoLoaded.current = key;
    setSelectedGameId(requestedGameId);
    setRevisionSelection({ gameId: requestedGameId, revision: requestedRevision });
    const selection = {
      gameId: requestedGameId,
      revision: requestedRevision,
      target: evidenceTarget,
    };
    load(selection, { onSuccess: (data) => selectLoadedEvidence(data, selection) });
    // StrictMode reconnects the mutation observer after its first effect cleanup.
    // Reattach the selection callback; fetchQuery shares the immutable revision request.
    return () => {
      autoLoaded.current = null;
    };
  }, [requestedGameId, requestedRevision, evidenceTarget, load, selectLoadedEvidence]);
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
    const selection = {
      gameId,
      revision,
      target: gameId === requestedGameId && revision === requestedRevision ? evidenceTarget : null,
    };
    replay.mutate(selection, { onSuccess: (data) => selectLoadedEvidence(data, selection) });
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
    evidenceNotice,
    frame,
    state,
  };
}

function parseRequestedRevision(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
