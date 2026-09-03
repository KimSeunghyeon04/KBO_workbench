import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CorrectionCommand, StagingRelayEventKind } from "@kbo/contracts";
import { useSearchParams } from "react-router-dom";

import { catalogQueryOptions, correctionSourceEvidenceQueryOptions } from "../api/query-options";
import {
  applyEventCollapse,
  buildEventCollapseModel,
  collapseOwnersForEvent,
  type EventCollapseKind,
} from "../correction/event-collapse";
import {
  buildAdjacentMoveCommand,
  buildImmediateDeleteCommand,
  insertionReferenceAfter,
  selectionAfterDelete,
} from "../correction/event-actions";
import { EVENT_KINDS, newCommandId } from "../correction/event-editor-registry";
import {
  buildCorrectionTimeline,
  buildEventPresentations,
  catalogAuthorityLabel,
  correctionGameKey,
  correctionGameLabel,
  eventKindLabel,
  filterCorrectionGames,
  type CorrectionGameScope,
} from "../correction/event-presentation";
import { kboLiveTextLink } from "../correction/kbo-live";
import { compareWithOriginal } from "../correction/original-comparison";
import { parseOfficialRecordIdentity, type RecordKind } from "../correction/record-comparison";
import { useCorrectionSessionController } from "../correction/use-correction-session-controller";
import { CorrectionDrawer } from "../correction/correction-drawer";
import { RecordCorrectionProposalPanel } from "../correction/record-correction-proposal-panel";
import {
  CorrectionCommitControls,
  EventDetail,
  FindingPanel,
  OriginalComparisonView,
  RecordDetail,
  VirtualEventList,
  type RowAction,
} from "../correction/correction-workbench-panels";

export { VirtualEventList } from "../correction/correction-workbench-panels";
export { CorrectionDrawer } from "../correction/correction-drawer";

type EventKindFilter = "all" | StagingRelayEventKind;

export function CorrectPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const requestedSessionId = searchParams.get("sessionId");
  const recordCorrectionNoticeId = searchParams.get("noticeId");
  const catalog = useQuery(catalogQueryOptions());
  const [scope, setScope] = useState<CorrectionGameScope>("review");
  const [gameQuery, setGameQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [eventQuery, setEventQuery] = useState("");
  const [eventKind, setEventKind] = useState<EventKindFilter>("all");
  const [onlyRelated, setOnlyRelated] = useState(false);
  const [collapsedInningEventIds, setCollapsedInningEventIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapsedPlateEventIds, setCollapsedPlateEventIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapseAnnouncement, setCollapseAnnouncement] = useState("");
  const [allowQuarantine, setAllowQuarantine] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedTrackingId, setSelectedTrackingId] = useState<string | null>(null);
  const [recordView, setRecordView] = useState<{
    readonly kind: RecordKind;
    readonly selectedRecordIdentity: string | null;
  } | null>(null);

  const catalogGames = useMemo(
    () =>
      (catalog.data?.games ?? []).filter(
        (game) => game.authority === "staging" || game.authority === "quarantine",
      ),
    [catalog.data],
  );
  const scopeCounts = {
    review: catalogGames.filter((game) => game.authority === "quarantine").length,
    ready: catalogGames.filter((game) => game.authority === "staging").length,
    all: catalogGames.length,
  };
  const games = useMemo(
    () => filterCorrectionGames(catalogGames, scope, gameQuery),
    [catalogGames, gameQuery, scope],
  );
  const selectedGame = games.find((item) => correctionGameKey(item) === selectedKey) ?? null;
  useEffect(() => {
    const first = games[0];
    if (first !== undefined && !games.some((item) => correctionGameKey(item) === selectedKey))
      setSelectedKey(correctionGameKey(first));
  }, [games, selectedKey]);
  useEffect(() => setConfirmOpen(false), [selectedKey]);

  const {
    session,
    selectedEventId,
    setSelectedEventId,
    drawer,
    setDrawer,
    notice,
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
    error: sessionError,
  } = useCorrectionSessionController(selectedGame);

  useEffect(() => {
    if (
      requestedSessionId !== null &&
      session?.sessionId !== requestedSessionId &&
      !adoptSession.isPending &&
      !adoptSession.isError
    )
      adoptSession.mutate(requestedSessionId);
  }, [adoptSession, requestedSessionId, session?.sessionId]);

  useEffect(() => {
    setRecordView(null);
    setSelectedTrackingId(null);
    setCollapsedInningEventIds(new Set());
    setCollapsedPlateEventIds(new Set());
    setCollapseAnnouncement("");
  }, [session?.sessionId]);

  useEffect(() => {
    if (session?.blockingCount === 0) setAllowQuarantine(false);
  }, [session?.blockingCount]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (session === null || busy || editableTarget(event.target)) return;
      const commandKey = event.ctrlKey || event.metaKey;
      if (!commandKey) return;
      if (event.key.toLowerCase() === "z" && event.shiftKey && session.canRedo) {
        event.preventDefault();
        history.mutate("redo");
      } else if (event.key.toLowerCase() === "z" && session.canUndo) {
        event.preventDefault();
        history.mutate("undo");
      } else if (event.key.toLowerCase() === "y" && session.canRedo) {
        event.preventDefault();
        history.mutate("redo");
      }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [busy, history, session]);

  const presentations = useMemo(
    () =>
      session === null ? [] : buildEventPresentations(session.draftDocument, session.eventContexts),
    [session],
  );
  const timelineRows = useMemo(() => buildCorrectionTimeline(presentations), [presentations]);
  const collapseModel = useMemo(() => buildEventCollapseModel(timelineRows), [timelineRows]);
  const relatedIds = useMemo(
    () =>
      new Set(
        [...(session?.findings ?? []), ...(session?.storedFindings ?? [])].flatMap((finding) =>
          finding.eventId === undefined ? [] : [finding.eventId],
        ),
      ),
    [session],
  );
  const filtersActive = eventQuery.trim() !== "" || eventKind !== "all" || onlyRelated;
  const filteredRows = useMemo(
    () =>
      timelineRows.filter((row) => {
        const presentation = row.presentation;
        if (onlyRelated && !relatedIds.has(presentation.event.identity.eventId)) return false;
        if (eventKind !== "all" && presentation.event.kind !== eventKind) return false;
        return (
          eventQuery.trim() === "" ||
          presentation.searchText.includes(eventQuery.trim().toLocaleLowerCase("ko-KR"))
        );
      }),
    [eventKind, eventQuery, onlyRelated, relatedIds, timelineRows],
  );
  const visibleRows = useMemo(
    () =>
      applyEventCollapse(
        filteredRows,
        collapseModel,
        collapsedInningEventIds,
        collapsedPlateEventIds,
        filtersActive,
      ),
    [collapseModel, collapsedInningEventIds, collapsedPlateEventIds, filteredRows, filtersActive],
  );
  const selectedPresentation = presentations.find(
    (item) => item.event.identity.eventId === selectedEventId,
  );
  const selectedContext = session?.eventContexts.find((item) => item.eventId === selectedEventId);
  const selectedSourceEventId =
    selectedPresentation?.event.identity.kind === "source"
      ? selectedPresentation.event.identity.eventId
      : null;
  const sourceEvidence = useQuery({
    ...correctionSourceEvidenceQueryOptions(
      session?.sessionId ?? "inactive",
      selectedSourceEventId ?? "inactive",
    ),
    enabled: session !== null && selectedSourceEventId !== null,
    retry: false,
  });
  const comparison =
    session !== null && original.data !== undefined
      ? compareWithOriginal(original.data, session.draftDocument)
      : null;
  const live = kboLiveTextLink(session?.gameId ?? selectedGame?.gameId);
  const promotionAvailable =
    session?.authority === "quarantine" && session.blockingCount === 0 && !session.dirty;
  const collapsedInningCount = validCollapsedCount(
    collapsedInningEventIds,
    collapseModel.inningEventIds,
  );
  const collapsedPlateCount = validCollapsedCount(
    collapsedPlateEventIds,
    collapseModel.plateEventIds,
  );

  const apply = (command: CorrectionCommand): void => mutation.mutate(command);
  const act = (eventId: string, action: RowAction): void => {
    if (session === null) return;
    const events = session.draftDocument.events;
    const event = events.find((item) => item.identity.eventId === eventId);
    if (event === undefined) return;
    if (action === "edit") {
      setDrawer({ mode: "replace_event", eventId });
      return;
    }
    if (action === "insert_before") {
      setDrawer({ mode: "add_event", beforeEventId: eventId, seedEvent: event });
      return;
    }
    if (action === "insert_after") {
      setDrawer({
        mode: "add_event",
        beforeEventId: insertionReferenceAfter(events, eventId),
        seedEvent: event,
      });
      return;
    }
    if (action === "move_to") {
      setDrawer({ mode: "move_event", eventId });
      return;
    }
    if (action === "delete") {
      setRecordView(null);
      setSelectedEventId(selectionAfterDelete(events, eventId));
      apply(buildImmediateDeleteCommand(session.draftDocument, eventId, newCommandId()));
      return;
    }
    const command = buildAdjacentMoveCommand(
      events,
      eventId,
      action === "move_up" ? "up" : "down",
      newCommandId(),
    );
    if (command !== null) apply(command);
  };

  const requestOpenSession = (): void => {
    if (session?.dirty === true) setConfirmOpen(true);
    else openSession.mutate();
  };
  const selectLedgerEvent = (eventId: string): void => {
    setRecordView(null);
    setSelectedTrackingId(null);
    setSelectedEventId(eventId);
  };
  const selectFindingEvent = (eventId: string): void => {
    const owners = collapseOwnersForEvent(collapseModel, eventId);
    const revealed: string[] = [];
    if (owners.inningEventId !== undefined && collapsedInningEventIds.has(owners.inningEventId))
      revealed.push("이닝");
    if (owners.plateEventId !== undefined && collapsedPlateEventIds.has(owners.plateEventId))
      revealed.push("타석");
    setCollapsedInningEventIds((current) => withoutId(current, owners.inningEventId));
    setCollapsedPlateEventIds((current) => withoutId(current, owners.plateEventId));
    setRecordView(null);
    setSelectedTrackingId(null);
    setEventQuery("");
    setEventKind("all");
    setOnlyRelated(false);
    setSelectedEventId(eventId);
    if (revealed.length > 0)
      setCollapseAnnouncement(`선택한 finding의 ${revealed.join("과 ")}을 펼쳤습니다.`);
  };
  const toggleCollapse = (kind: EventCollapseKind, eventId: string): void => {
    const groups = collapseModel.groupsByEventId.get(eventId) ?? [];
    const group = groups.find((candidate) => candidate.kind === kind);
    if (group === undefined) return;
    const current = kind === "inning" ? collapsedInningEventIds : collapsedPlateEventIds;
    const next = new Set(current);
    const collapsed = next.has(eventId);
    if (collapsed) next.delete(eventId);
    else next.add(eventId);
    if (kind === "inning") setCollapsedInningEventIds(next);
    else setCollapsedPlateEventIds(next);
    setCollapseAnnouncement(
      `${group.label} ${kind === "inning" ? "이닝" : "타석"}을 ${collapsed ? "펼쳤습니다." : `접었습니다. ${String(group.childCount)}행이 숨겨집니다.`}`,
    );
  };
  const collapseAll = (kind: EventCollapseKind): void => {
    const eventIds = kind === "inning" ? collapseModel.inningEventIds : collapseModel.plateEventIds;
    const collapsible = eventIds.filter((eventId) =>
      (collapseModel.groupsByEventId.get(eventId) ?? []).some(
        (group) => group.kind === kind && group.childCount > 0,
      ),
    );
    if (kind === "inning") setCollapsedInningEventIds(new Set(collapsible));
    else setCollapsedPlateEventIds(new Set(collapsible));
    setCollapseAnnouncement(
      `${kind === "inning" ? "이닝" : "타석"} ${String(collapsible.length)}개를 모두 접었습니다.`,
    );
  };
  const expandAll = (): void => {
    setCollapsedInningEventIds(new Set());
    setCollapsedPlateEventIds(new Set());
    setCollapseAnnouncement("모든 이닝과 타석을 펼쳤습니다.");
  };
  const selectRecord = (recordIdentity: string): void => {
    const parsed = parseOfficialRecordIdentity(recordIdentity);
    if (parsed === null) return;
    setSelectedTrackingId(null);
    setRecordView({ kind: parsed.kind, selectedRecordIdentity: recordIdentity });
  };
  const selectTracking = (trackingId: string): void => {
    setRecordView(null);
    setSelectedTrackingId(trackingId);
    if (session === null) {
      setSelectedEventId(null);
      return;
    }
    const candidate = session.draftDocument.trackingCandidates.find(
      (item) => item.trackingId === trackingId,
    );
    if (candidate === undefined) {
      setSelectedEventId(null);
      return;
    }
    let pitchEventId: string | null = null;
    if (candidate.resolution.kind === "linked") {
      pitchEventId = candidate.resolution.pitchEventId;
    } else if (candidate.resolution.kind === "duplicate") {
      const canonicalTrackingId = candidate.resolution.canonicalTrackingId;
      const canonical = session.draftDocument.trackingCandidates.find(
        (item) => item.trackingId === canonicalTrackingId,
      );
      if (canonical?.resolution.kind === "linked") {
        pitchEventId = canonical.resolution.pitchEventId;
      }
    } else if (candidate.sourcePitchId !== undefined) {
      const matches = session.draftDocument.events.filter(
        (event) =>
          event.kind === "pitch" &&
          event.payload.sourcePitchId === candidate.sourcePitchId &&
          event.identity.kind === "source" &&
          event.identity.endpoint === candidate.source.endpoint &&
          event.identity.blockIndex === candidate.source.blockIndex,
      );
      if (matches.length === 1) pitchEventId = matches[0]?.identity.eventId ?? null;
    }
    setSelectedEventId(pitchEventId);
  };
  const error = sessionError ?? catalog.error;

  return (
    <div className="page-stack correction-page">
      <header className="page-header">
        <div>
          <h1>중계 원장 보정</h1>
          <p>
            Naver 중계 행을 버리지 않고 정리합니다. 최종 경기 구조는 DB 적재 시 compiler가 만듭니다.
          </p>
        </div>
      </header>
      <section className="panel correction-source-bar">
        <div className="correction-source-heading">
          <div>
            <h2>파일 원장 선택</h2>
            <p>검토가 필요한 경기부터 열고 현재 compiler 결과를 기준으로 보정합니다.</p>
          </div>
          <div className="correction-scope-tabs" role="group" aria-label="보정 대상 범위">
            {(
              [
                ["review", "검토 필요"],
                ["ready", "적재 가능"],
                ["all", "전체"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={scope === value ? "active" : ""}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
              >
                {label} <span>{String(scopeCounts[value])}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="correction-source-controls">
          <label>
            <span>경기 검색</span>
            <input
              value={gameQuery}
              onChange={(event) => setGameQuery(event.target.value)}
              placeholder="경기 ID·시즌"
            />
          </label>
          <label>
            <span>경기</span>
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              <option value="">경기 선택</option>
              {games.map((game) => (
                <option key={correctionGameKey(game)} value={correctionGameKey(game)}>
                  {correctionGameLabel(game)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="primary-button correction-open-button"
            disabled={selectedGame === null || busy}
            aria-busy={openSession.isPending}
            onClick={requestOpenSession}
          >
            {openSession.isPending ? "작업 사본 여는 중…" : "작업 사본 열기"}
          </button>
          <a
            className="secondary-button correction-live-button"
            href={live.url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={live.error ?? "KBO 공식 문자중계 열기"}
            aria-disabled={live.url === null}
          >
            KBO 문자중계
          </a>
        </div>
        {confirmOpen ? (
          <div className="open-session-confirmation" role="alert">
            <span>현재 작업 사본의 저장하지 않은 변경을 버리고 선택한 경기를 여시겠습니까?</span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmOpen(false)}
            >
              현재 작업 계속
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setConfirmOpen(false);
                openSession.mutate();
              }}
            >
              변경 버리고 열기
            </button>
          </div>
        ) : null}
      </section>
      {error !== null ? (
        <div className="error-panel" role="alert">
          {error.message}
        </div>
      ) : null}
      {notice !== "" ? (
        <div className="notice-panel" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}
      {session === null ? (
        <section className="panel correction-empty">
          <p>파일 원장을 선택해 작업 사본을 여세요.</p>
        </section>
      ) : (
        <>
          <section className="panel correction-game-summary">
            <div>
              <strong>{session.gameId}</strong>
              <span>{catalogAuthorityLabel(session.authority)}</span>
              <code>
                {session.dirty
                  ? "저장하지 않은 변경 있음"
                  : promotionAvailable
                    ? "staging 승격 가능"
                    : "저장됨"}
              </code>
            </div>
            <div className="correction-validation-summary">
              <span className={session.blockingCount > 0 ? "blocking" : "clear"}>
                차단 {String(session.blockingCount)}
              </span>
              <span>경고 {String(session.warningCount)}</span>
              <span>원장 {String(session.draftDocument.events.length)}행</span>
            </div>
          </section>
          {recordCorrectionNoticeId !== null ? (
            <RecordCorrectionProposalPanel
              session={session}
              noticeId={recordCorrectionNoticeId}
              onApplied={(result) =>
                acceptExternalMutation(
                  result,
                  "KBO 기록정정 batch를 작업 사본에 반영했습니다. 저장과 DB 적재는 아직 수행하지 않았습니다.",
                )
              }
            />
          ) : null}
          <section className="panel correction-toolbar" aria-label="원장 작업">
            <button
              type="button"
              className="secondary-button"
              disabled={!session.canUndo || busy}
              onClick={() => history.mutate("undo")}
            >
              실행 취소
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!session.canRedo || busy}
              onClick={() => history.mutate("redo")}
            >
              다시 실행
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-pressed={recordView?.kind === "batter"}
              onClick={() => setRecordView({ kind: "batter", selectedRecordIdentity: null })}
            >
              타자 기록
            </button>
            <button
              type="button"
              className="secondary-button"
              aria-pressed={recordView?.kind === "pitcher"}
              onClick={() => setRecordView({ kind: "pitcher", selectedRecordIdentity: null })}
            >
              투수 기록
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => {
                const seedEvent = session.draftDocument.events.at(-1);
                setDrawer(
                  seedEvent === undefined
                    ? { mode: "add_event", beforeEventId: null }
                    : { mode: "add_event", beforeEventId: null, seedEvent },
                );
              }}
            >
              행 추가
            </button>
          </section>
          {lastPreview !== null ? (
            <div className="panel correction-last-change" role="status">
              <strong>최근 반영</strong>
              <span>
                차단 {String(lastPreview.beforeBlockingCount)} →{" "}
                {String(lastPreview.afterBlockingCount)}
              </span>
              <span>
                경고 {String(lastPreview.beforeWarningCount)} →{" "}
                {String(lastPreview.afterWarningCount)}
              </span>
              <span>
                원장 행 {lastPreview.eventCountDelta > 0 ? "+" : ""}
                {String(lastPreview.eventCountDelta)}
              </span>
            </div>
          ) : null}
          <div className="correction-workbench">
            <FindingPanel
              session={session}
              selectedEventId={selectedEventId}
              selectedRecordIdentity={recordView?.selectedRecordIdentity ?? null}
              selectedTrackingId={selectedTrackingId}
              onSelectEvent={selectFindingEvent}
              onSelectRecord={selectRecord}
              onSelectTracking={selectTracking}
            />
            <section className="panel correction-events">
              <div className="panel-title-row">
                <h2>중계 원장</h2>
                <span>
                  {String(visibleRows.length)} / {String(session.draftDocument.events.length)}행
                </span>
              </div>
              <div className="event-filters">
                <input
                  type="search"
                  value={eventQuery}
                  aria-label="원장 행 검색"
                  onChange={(event) => setEventQuery(event.target.value)}
                  placeholder="선수·원문·종류·ID 검색"
                />
                <select
                  value={eventKind}
                  aria-label="원장 행 종류"
                  onChange={(event) => setEventKind(event.target.value as EventKindFilter)}
                >
                  <option value="all">모든 행 종류</option>
                  {EVENT_KINDS.map((kind) => (
                    <option value={kind} key={kind}>
                      {eventKindLabel(kind)}
                    </option>
                  ))}
                </select>
                <label className="event-problem-filter">
                  <input
                    type="checkbox"
                    checked={onlyRelated}
                    onChange={(event) => setOnlyRelated(event.target.checked)}
                  />
                  문제 관련 행만
                </label>
                <div className="event-collapse-toolbar" role="group" aria-label="원장 그룹 접기">
                  <button
                    type="button"
                    disabled={busy || filtersActive}
                    onClick={() => collapseAll("inning")}
                  >
                    이닝 모두 접기
                  </button>
                  <button
                    type="button"
                    disabled={busy || filtersActive}
                    onClick={() => collapseAll("plate")}
                  >
                    타석 모두 접기
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      filtersActive ||
                      (collapsedInningCount === 0 && collapsedPlateCount === 0)
                    }
                    onClick={expandAll}
                  >
                    모두 펼치기
                  </button>
                  <small>
                    {filtersActive
                      ? "검색·필터 중에는 일치하는 모든 행을 표시합니다."
                      : `이닝 ${String(collapsedInningCount)} · 타석 ${String(collapsedPlateCount)} 접힘`}
                  </small>
                </div>
              </div>
              <span className="screen-reader-only" role="status" aria-live="polite">
                {collapseAnnouncement}
              </span>
              <VirtualEventList
                rows={visibleRows}
                canonicalEvents={session.draftDocument.events}
                selectedEventId={selectedEventId}
                disabled={busy}
                collapseGroups={collapseModel.groupsByEventId}
                collapsedInningEventIds={collapsedInningEventIds}
                collapsedPlateEventIds={collapsedPlateEventIds}
                collapseDisabled={filtersActive}
                onSelect={selectLedgerEvent}
                onAction={act}
                onToggleCollapse={toggleCollapse}
              />
            </section>
            {recordView === null ? (
              <EventDetail
                presentation={selectedPresentation}
                context={selectedContext}
                findings={session.findings.filter((item) => item.eventId === selectedEventId)}
                document={session.draftDocument}
                eventContexts={session.eventContexts}
                exceptionTrackingId={selectedTrackingId}
                sourceEvidence={sourceEvidence.data}
                sourceEvidencePending={sourceEvidence.isFetching}
                sourceEvidenceError={sourceEvidence.error}
                pending={busy}
                onApply={apply}
              />
            ) : (
              <RecordDetail
                document={session.draftDocument}
                calculatedRecords={session.calculatedRecords}
                kind={recordView.kind}
                selectedRecordIdentity={recordView.selectedRecordIdentity}
                onKindChange={(kind) => setRecordView({ kind, selectedRecordIdentity: null })}
                onSelectRecord={selectRecord}
                onClose={() => setRecordView(null)}
              />
            )}
          </div>
          <section className="panel correction-commit-panel">
            <div className="section-heading">
              <div>
                <h2>작업 사본 저장</h2>
                <p className="muted-text">
                  저장할 때 base hash를 다시 확인하고 compiler 결과에 따라 staging 또는 quarantine에
                  반영합니다.
                </p>
              </div>
              <span className="item-state">
                {session.dirty ? "저장 필요" : promotionAvailable ? "승격 가능" : "변경 없음"}
              </span>
            </div>
            <CorrectionCommitControls
              dirty={session.dirty}
              promotionAvailable={promotionAvailable}
              blockingCount={session.blockingCount}
              busy={busy}
              allowQuarantine={allowQuarantine}
              onAllowQuarantine={setAllowQuarantine}
              onCommit={(allowed) => commit.mutate(allowed)}
            />
            <div className="restore-row">
              <div>
                <strong>최초 정리 원장으로 되돌리기</strong>
                <p className="muted-text">
                  불러온 뒤에도 실행 취소로 현재 작업 사본을 복원할 수 있습니다.
                </p>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || original.data === undefined}
                onClick={() => loadOriginal.mutate()}
              >
                최초 원장 불러오기
              </button>
            </div>
            {original.error !== null ? (
              <p className="inline-error">{original.error.message}</p>
            ) : null}
            {comparison !== null ? <OriginalComparisonView comparison={comparison} /> : null}
          </section>
          {drawer !== null ? (
            <CorrectionDrawer
              request={drawer}
              session={session}
              selectedEvent={
                drawer.mode === "replace_event" || drawer.mode === "move_event"
                  ? session.draftDocument.events.find(
                      (item) => item.identity.eventId === drawer.eventId,
                    )
                  : undefined
              }
              pending={busy}
              error={mutation.error}
              onClose={() => setDrawer(null)}
              onApply={apply}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))
  );
}

function withoutId(current: ReadonlySet<string>, eventId: string | undefined): ReadonlySet<string> {
  if (eventId === undefined || !current.has(eventId)) return current;
  const next = new Set(current);
  next.delete(eventId);
  return next;
}

function validCollapsedCount(
  collapsed: ReadonlySet<string>,
  validEventIds: readonly string[],
): number {
  return validEventIds.filter((eventId) => collapsed.has(eventId)).length;
}

export { newCommandId };
