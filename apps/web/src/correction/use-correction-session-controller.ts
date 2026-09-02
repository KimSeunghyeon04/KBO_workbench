import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CorrectionCommand,
  CorrectionPreview,
  CorrectionSession,
  GameCatalogItem,
} from "@kbo/contracts";

import {
  commitCorrection,
  createCorrectionSession,
  getCorrectionSession,
  loadCorrectionOriginal,
  moveCorrectionHistory,
  submitCorrectionCommand,
} from "../api/client";
import { correctionOriginalQueryOptions, queryKeys } from "../api/query-options";
import type { DrawerRequest } from "./event-editor-registry";

export function useCorrectionSessionController(selectedGame: GameCatalogItem | null) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<CorrectionSession | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerRequest | null>(null);
  const [notice, setNotice] = useState("");
  const [lastPreview, setLastPreview] = useState<CorrectionPreview | null>(null);

  const openSession = useMutation({
    mutationFn: async () => {
      if (selectedGame === null) throw new Error("보정할 경기를 선택하세요.");
      if (selectedGame.authority !== "staging" && selectedGame.authority !== "quarantine") {
        throw new Error("현재 파일 원장만 보정 session으로 열 수 있습니다.");
      }
      return createCorrectionSession(selectedGame.authority, selectedGame.gameId);
    },
    onSuccess(next) {
      setSession(next);
      setSelectedEventId(next.draftDocument.events[0]?.identity.eventId ?? null);
      setDrawer(null);
      setLastPreview(null);
      setNotice("작업 사본을 열었습니다.");
    },
  });
  const adoptSession = useMutation({
    mutationFn: (sessionId: string) => getCorrectionSession(sessionId),
    onSuccess(next) {
      setSession(next);
      setSelectedEventId(next.draftDocument.events[0]?.identity.eventId ?? null);
      setDrawer(null);
      setLastPreview(null);
      setNotice("KBO 기록정정 작업 사본을 열었습니다.");
    },
  });
  const mutation = useMutation({
    mutationFn: async (command: CorrectionCommand) => {
      if (session === null) throw new Error("열린 작업 사본이 없습니다.");
      return submitCorrectionCommand(session.sessionId, session.sessionVersion, command, true);
    },
    onSuccess(result, command) {
      setSession(result.session);
      setDrawer(null);
      setLastPreview(result.preview);
      const addedEvents =
        command.kind === "add_event"
          ? [command.event]
          : command.kind === "correction_batch"
            ? command.commands.flatMap((item) => (item.kind === "add_event" ? [item.event] : []))
            : [];
      const lastAddedEvent = addedEvents.at(-1);
      if (lastAddedEvent !== undefined) setSelectedEventId(lastAddedEvent.identity.eventId);
      const delta = result.preview.eventCountDelta;
      setNotice(
        addedEvents.length > 1
          ? `${String(addedEvents.length)}개 행을 한 번에 반영했습니다. 차단 ${String(result.preview.beforeBlockingCount)} → ${String(result.preview.afterBlockingCount)} · 원장 행 +${String(delta)}`
          : `즉시 반영했습니다. 차단 ${String(result.preview.beforeBlockingCount)} → ${String(result.preview.afterBlockingCount)}${delta === 0 ? "" : ` · 원장 행 ${delta > 0 ? "+" : ""}${String(delta)}`}`,
      );
    },
  });
  const history = useMutation({
    mutationFn: async (direction: "undo" | "redo") => {
      if (session === null) throw new Error("열린 작업 사본이 없습니다.");
      return moveCorrectionHistory(session.sessionId, session.sessionVersion, direction);
    },
    onSuccess(result) {
      setSession(result.session);
      setLastPreview(result.preview);
      setNotice("작업 이력을 이동했습니다.");
    },
  });
  const commit = useMutation({
    mutationFn: async (allowQuarantine: boolean) => {
      if (session === null) throw new Error("열린 작업 사본이 없습니다.");
      return commitCorrection(session.sessionId, session.sessionVersion, allowQuarantine);
    },
    onSuccess(result) {
      setSession(result.session);
      setLastPreview(null);
      setNotice(
        result.committedAuthority === "staging"
          ? "적재 가능한 현재 원장으로 저장했습니다."
          : "차단 finding과 함께 격리 원장으로 저장했습니다.",
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog });
    },
  });
  const original = useQuery({
    ...correctionOriginalQueryOptions(session?.sessionId ?? "inactive"),
    enabled: session !== null,
  });
  const loadOriginal = useMutation({
    mutationFn: async () => {
      if (session === null) throw new Error("열린 작업 사본이 없습니다.");
      return loadCorrectionOriginal(session.sessionId, session.sessionVersion);
    },
    onSuccess(result) {
      setSession(result.session);
      setLastPreview(result.preview);
      setNotice("최초 정리 원장을 작업 사본으로 불러왔습니다.");
    },
  });

  const busy =
    openSession.isPending ||
    adoptSession.isPending ||
    mutation.isPending ||
    history.isPending ||
    commit.isPending ||
    loadOriginal.isPending;
  const error =
    openSession.error ??
    mutation.error ??
    history.error ??
    commit.error ??
    loadOriginal.error ??
    adoptSession.error ??
    null;
  const acceptExternalMutation = (
    result: Awaited<ReturnType<typeof submitCorrectionCommand>>,
    message: string,
  ): void => {
    setSession(result.session);
    setLastPreview(result.preview);
    setNotice(message);
  };
  return {
    session,
    selectedEventId,
    setSelectedEventId,
    drawer,
    setDrawer,
    notice,
    setNotice,
    lastPreview,
    openSession,
    adoptSession,
    acceptExternalMutation,
    mutation,
    history,
    commit,
    original,
    loadOriginal,
    busy,
    error,
  };
}
