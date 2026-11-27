import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import { loadReplay } from "../api/client";
import type { LoadedReplay } from "../api/replay-client";
import {
  replayCatalogCalendarQueryOptions,
  replayCatalogPageQueryOptions,
  revisionCatalogQueryOptions,
} from "../api/query-options";
import { summarizeReplayCalendar } from "./catalog";
import { nextReplayIndex, replayDelay } from "./playback";
import {
  readReplayEvidenceTarget,
  replayEvidenceIndex,
  replayEvidenceLabels,
  replayOpenKey,
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
  const openGame = searchParams.get(replayOpenKey) === "1";
  const evidenceTarget = useMemo(() => readReplayEvidenceTarget(searchParams), [searchParams]);
  const autoLoaded = useRef<string | null>(null);
  const automaticSelection = useMemo(
    () =>
      requestedGameId && requestedRevision !== null && (openGame || evidenceTarget !== null)
        ? { gameId: requestedGameId, revision: requestedRevision, target: evidenceTarget }
        : null,
    [requestedGameId, requestedRevision, openGame, evidenceTarget],
  );
  const [failedAutomaticSelection, setFailedAutomaticSelection] = useState<ReplaySelection | null>(
    null,
  );
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [requestedPage, setPage] = useState(1);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(requestedGameId);
  const [revisionSelection, setRevisionSelection] = useState<RevisionSelection | null>(
    requestedGameId === null || requestedRevision === null
      ? null
      : { gameId: requestedGameId, revision: requestedRevision },
  );
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
  const loadedReplay = replay.data;
  const awaitingAutomatic =
    automaticSelection !== null &&
    automaticSelection !== failedAutomaticSelection &&
    loadedReplay === undefined;
  const showPicker = (loadedReplay === undefined && !awaitingAutomatic) || sourceOpen;
  const games = useQuery({
    ...replayCatalogPageQueryOptions({
      page: requestedPage,
      ...(seasonFilter === "all" ? {} : { season: Number(seasonFilter) }),
      ...(deferredSearch === "" ? {} : { search: deferredSearch }),
      ...(selectedDate === null ? {} : { gameDate: selectedDate }),
      ...(selectedGameId !== null && /^[A-Za-z0-9_-]{1,100}$/.test(selectedGameId)
        ? { selectedGameId }
        : {}),
    }),
    enabled: showPicker,
  });
  const calendar = useQuery({ ...replayCatalogCalendarQueryOptions(), enabled: showPicker });
  useEffect(() => {
    if (games.data === undefined || games.isPlaceholderData) return;
    const lastPage = Math.max(1, Math.ceil(games.data.total / games.data.limit));
    if (requestedPage > lastPage) setPage(lastPage);
  }, [games.data, games.isPlaceholderData, requestedPage]);
  const gameId = selectedGameId ?? games.data?.selectedGame?.gameId ?? "";
  const revisions = useQuery({
    ...revisionCatalogQueryOptions(gameId),
    enabled: showPicker && gameId !== "",
  });
  const revision =
    revisionSelection !== null && revisionSelection.gameId === gameId
      ? revisionSelection.revision
      : (revisions.data?.currentRevision ?? null);
  const { mutate: load } = replay;
  useEffect(() => {
    if (automaticSelection === null) return;
    const key = JSON.stringify(automaticSelection);
    if (autoLoaded.current === key) return;
    autoLoaded.current = key;
    const { gameId, revision } = automaticSelection;
    setSelectedGameId(gameId);
    setRevisionSelection({ gameId, revision });
    load(automaticSelection, {
      onSuccess: (data) => selectLoadedEvidence(data, automaticSelection),
      onError: () => setFailedAutomaticSelection(automaticSelection),
    });
    // StrictMode reconnects the mutation observer after its first effect cleanup.
    // Reattach the selection callback; fetchQuery shares the immutable revision request.
    return () => {
      autoLoaded.current = null;
    };
  }, [automaticSelection, load, selectLoadedEvidence]);
  const {
    total: storedCount,
    seasons,
    months: calendarMonths,
    dateCounts,
  } = useMemo(
    () => summarizeReplayCalendar(calendar.data ?? [], seasonFilter),
    [calendar.data, seasonFilter],
  );
  const filteredGames = games.data?.games ?? [];
  const candidate = games.data?.selectedGame;
  const selectedGame =
    candidate?.gameId === gameId
      ? candidate
      : (filteredGames.find((item) => item.gameId === gameId) ?? null);
  const selectedGameMonth = selectedGame?.gameDate.slice(0, 7);
  const fallbackMonth =
    selectedGameMonth !== undefined && calendarMonths.includes(selectedGameMonth)
      ? selectedGameMonth
      : (calendarMonths.at(-1) ?? "");
  const visibleMonth = calendarMonths.includes(requestedMonth) ? requestedMonth : fallbackMonth;

  useEffect(() => {
    if (!sourceOpen) return;
    searchInputRef.current?.focus();
  }, [sourceOpen]);

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
    setPage(1);
  }

  function setVisibleMonth(nextMonth: string): void {
    setRequestedMonth(nextMonth);
    selectDate(null);
  }

  function selectDate(nextDate: string | null): void {
    setSelectedDate(nextDate);
    setPage(1);
  }

  function changeSearch(nextSearch: string): void {
    setSearch(nextSearch);
    setPage(1);
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
    catalogError: games.error ?? calendar.error,
    loadingGames: showPicker && (games.isPending || calendar.isPending || games.isPlaceholderData),
    storedCount,
    filteredCount: games.data?.total ?? 0,
    page: games.data?.page ?? requestedPage,
    pageSize: games.data?.limit ?? 50,
    setPage,
    showPicker,
    awaitingAutomatic,
    search,
    setSearch: changeSearch,
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
    setSelectedDate: selectDate,
    visibleMonth,
    setVisibleMonth,
    searchInputRef,
    seasons,
    calendarMonths,
    dateCounts,
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
