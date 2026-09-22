import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CorrectionCommand,
  CorrectionEventContext,
  CorrectionFinding,
  CorrectionSession,
  CorrectionSourceEvidence,
  StagingGameDocumentV2,
  StagingRelayEvent,
} from "@kbo/contracts";

import { useFixedVirtualList } from "../components/use-fixed-virtual-list";
import type { EventCollapseGroup, EventCollapseKind } from "./event-collapse";
import { eventMoveCapabilities } from "./event-actions";
import { newCommandId } from "./event-editor-registry";
import {
  eventKindLabel,
  type CorrectionTimelinePresentation,
  type EventPresentation,
} from "./event-presentation";
import {
  buildDisplayFindings,
  findingIdentity,
  groupDisplayFindings,
  type DisplayFinding,
} from "./finding-presentation";
import type { OriginalComparison } from "./original-comparison";
import { PitchTrackingDetail } from "./pitch-tracking-detail";
import { focusedSourceEvidence } from "./source-evidence-presentation";
import {
  buildPlayerRecordComparisons,
  parseOfficialRecordIdentity,
  recordFieldLabel,
  recordIdentityLabel,
  recordKindLabel,
  type RecordComparisonStatus,
  type RecordKind,
} from "./record-comparison";
import {
  isRepairableTrackingPlateAppearanceFinding,
  trackingCandidateForFinding,
  trackingCandidatesForFinding,
  trackingFindingLocation,
  trackingSourceLocation,
} from "./tracking-review";

export type RowAction =
  "edit" | "move_up" | "move_down" | "delete" | "insert_before" | "insert_after" | "move_to";

export function CorrectionCommitControls({
  dirty,
  promotionAvailable,
  blockingCount,
  busy,
  allowQuarantine,
  onAllowQuarantine,
  onCommit,
}: {
  readonly dirty: boolean;
  readonly promotionAvailable: boolean;
  readonly blockingCount: number;
  readonly busy: boolean;
  readonly allowQuarantine: boolean;
  readonly onAllowQuarantine: (allowed: boolean) => void;
  readonly onCommit: (allowQuarantine: boolean) => void;
}): React.JSX.Element {
  const canCommit = dirty || promotionAvailable;
  return (
    <div className="commit-form">
      {blockingCount > 0 ? (
        <label className="check-field">
          <input
            type="checkbox"
            checked={allowQuarantine}
            onChange={(event) => onAllowQuarantine(event.target.checked)}
          />
          차단 finding을 확인했으며 quarantine 저장을 허용합니다.
        </label>
      ) : null}
      <button
        type="button"
        className="primary-button"
        disabled={busy || !canCommit || (blockingCount > 0 && !allowQuarantine)}
        onClick={() => onCommit(allowQuarantine)}
      >
        {blockingCount > 0
          ? "격리 원장 저장"
          : promotionAvailable && !dirty
            ? "staging으로 승격"
            : "현재 원장 저장"}
      </button>
    </div>
  );
}

export function FindingPanel({
  session,
  selectedEventId,
  selectedRecordIdentity,
  selectedTrackingId,
  onSelectEvent,
  onSelectRecord,
  onSelectTracking,
}: {
  readonly session: Pick<
    CorrectionSession,
    "storedFindings" | "findings" | "draftDocument" | "eventContexts"
  >;
  readonly selectedEventId: string | null;
  readonly selectedRecordIdentity: string | null;
  readonly selectedTrackingId: string | null;
  readonly onSelectEvent: (id: string) => void;
  readonly onSelectRecord: (recordIdentity: string) => void;
  readonly onSelectTracking: (trackingId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [origin, setOrigin] = useState<"current" | "stored" | "all">("current");
  const allFindings = useMemo(
    () => buildDisplayFindings(session, origin !== "current"),
    [origin, session],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const visibleFindings = allFindings.filter((finding) => {
    if (severity !== "all" && finding.severity !== severity) return false;
    if (category !== "all" && finding.category !== category) return false;
    if (origin === "current" && finding.origin === "stored") return false;
    if (origin === "stored" && finding.origin === "current") return false;
    return (
      normalizedQuery === "" ||
      findingSearchText(finding, session.draftDocument, session.eventContexts).includes(
        normalizedQuery,
      )
    );
  });

  const groups = groupDisplayFindings(visibleFindings, session.draftDocument);
  const firstRejected = session.eventContexts.find(
    (context) =>
      !context.applied &&
      session.findings.some(
        (finding) => finding.severity === "blocking" && finding.eventId === context.eventId,
      ),
  );
  return (
    <section className="panel correction-findings">
      <div className="panel-title-row">
        <h2>현재 보정할 문제</h2>
        <span>
          {String(visibleFindings.length)} / {String(allFindings.length)}건
        </span>
      </div>
      <div className="finding-filters">
        <input
          type="search"
          value={query}
          aria-label="finding 검색"
          placeholder="메시지·코드·행 검색"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={severity}
          aria-label="finding 심각도"
          onChange={(event) => setSeverity(event.target.value)}
        >
          <option value="all">모든 심각도</option>
          <option value="blocking">차단</option>
          <option value="warning">경고</option>
        </select>
        <select
          value={category}
          aria-label="finding 범주"
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="all">모든 범주</option>
          <option value="source">source</option>
          <option value="domain">domain</option>
          <option value="persistence">persistence</option>
        </select>
        <select
          value={origin}
          aria-label="finding 시점"
          onChange={(event) => setOrigin(event.target.value as "current" | "stored" | "all")}
        >
          <option value="current">현재 finding</option>
          <option value="stored">저장 당시 finding</option>
          <option value="all">현재 + 저장 당시</option>
        </select>
      </div>
      <div className="finding-list">
        {firstRejected === undefined ? null : (
          <button
            type="button"
            className="secondary-button finding-first-cause"
            onClick={() => onSelectEvent(firstRejected.eventId)}
          >
            먼저 확인할 미적용 행으로 이동
          </button>
        )}
        {groups.length > 0 ? (
          <p className="muted-text">
            같은 반이닝·검증 유형별로 묶었습니다. 각 항목의 원인은 별도로 확인하세요.
          </p>
        ) : null}
        {visibleFindings.length === 0 ? (
          <p className="muted-text">조건에 맞는 finding이 없습니다.</p>
        ) : (
          groups.map((group, index) => (
            <details
              className="finding-group"
              key={group.key}
              open={
                index === 0 || group.findings.some((finding) => finding.eventId === selectedEventId)
              }
            >
              <summary>
                {group.label} <b>{group.findings.length}건</b>
              </summary>
              {group.findings.map((finding) => {
                const record = parseOfficialRecordIdentity(finding.recordIdentity);
                const tracking = trackingCandidateForFinding(session.draftDocument, finding);
                const selected =
                  record !== null
                    ? finding.recordIdentity === selectedRecordIdentity
                    : tracking !== null
                      ? tracking.trackingId === selectedTrackingId
                      : finding.eventId === selectedEventId;
                const className = `finding-item ${finding.severity} ${selected ? "selected" : ""}`;
                const content = (
                  <FindingContents
                    finding={finding}
                    document={session.draftDocument}
                    eventContexts={session.eventContexts}
                  />
                );
                const eventId = finding.eventId;
                return record === null && tracking === null && eventId === undefined ? (
                  <article className={className} key={findingIdentity(finding)}>
                    {content}
                  </article>
                ) : (
                  <button
                    key={findingIdentity(finding)}
                    type="button"
                    className={className}
                    onClick={() => {
                      if (record !== null && finding.recordIdentity !== undefined)
                        onSelectRecord(finding.recordIdentity);
                      else if (tracking !== null) onSelectTracking(tracking.trackingId);
                      else if (eventId !== undefined) onSelectEvent(eventId);
                    }}
                  >
                    {content}
                  </button>
                );
              })}
            </details>
          ))
        )}
      </div>
    </section>
  );
}

function FindingContents({
  finding,
  document,
  eventContexts,
}: {
  readonly finding: DisplayFinding;
  readonly document: StagingGameDocumentV2;
  readonly eventContexts: readonly CorrectionEventContext[];
}): React.JSX.Element {
  const recordLabel = recordIdentityLabel(document, finding.recordIdentity);
  const tracking = trackingCandidateForFinding(document, finding);
  return (
    <>
      <span className="finding-meta">
        <b>{finding.severity === "blocking" ? "차단" : "경고"}</b>
        <i>{finding.category}</i>
        <i>{findingOriginLabel(finding.origin)}</i>
      </span>
      <strong>{finding.message}</strong>
      <span className="finding-location">
        {recordLabel ??
          (tracking === null
            ? finding.eventSequence === undefined
              ? "경기 전체"
              : `${String(finding.eventSequence + 1)}행`
            : trackingFindingLocation(document, tracking, eventContexts))}
      </span>
      {tracking === null ? (
        <FindingDetails
          code={finding.code}
          details={finding.details}
          recordIdentity={finding.recordIdentity}
        />
      ) : (
        <TrackingFindingDetails finding={finding} document={document} />
      )}
      {tracking === null ? null : (
        <span className="finding-navigation-hint">
          선택하면 관련 투구 행 또는 우측 tracking 예외를 엽니다.
        </span>
      )}
      <code>{finding.code}</code>
    </>
  );
}

function TrackingFindingDetails({
  finding,
  document,
}: {
  readonly finding: DisplayFinding;
  readonly document: StagingGameDocumentV2;
}): React.JSX.Element {
  const candidates = trackingCandidatesForFinding(document, finding);
  return (
    <ul className="finding-details tracking-finding-details">
      {candidates.map((candidate, index) => (
        <li key={candidate.trackingId}>
          후보 {String(index + 1)} · {trackingSourceLocation(candidate)}
        </li>
      ))}
    </ul>
  );
}

export function RecordDetail({
  document,
  calculatedRecords,
  kind,
  selectedRecordIdentity,
  onKindChange,
  onSelectRecord,
  onClose,
}: {
  readonly document: StagingGameDocumentV2;
  readonly calculatedRecords: CorrectionSession["calculatedRecords"];
  readonly kind: RecordKind;
  readonly selectedRecordIdentity: string | null;
  readonly onKindChange: (kind: RecordKind) => void;
  readonly onSelectRecord: (recordIdentity: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const comparisons = useMemo(
    () => buildPlayerRecordComparisons(document, calculatedRecords),
    [calculatedRecords, document],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const records = comparisons.filter(
    (record) =>
      record.kind === kind &&
      (normalizedQuery === "" ||
        [record.playerName, record.playerId, record.teamName]
          .join(" ")
          .toLocaleLowerCase("ko-KR")
          .includes(normalizedQuery)),
  );
  const selected =
    records.find((record) => record.recordIdentity === selectedRecordIdentity) ?? records[0];
  const batterCount = comparisons.filter((record) => record.kind === "batter").length;
  const pitcherCount = comparisons.filter((record) => record.kind === "pitcher").length;

  return (
    <section className="panel correction-detail correction-record-detail">
      <div className="panel-title-row">
        <h2>공식 기록 비교</h2>
        <button type="button" className="text-button" onClick={onClose}>
          원장 행 상세
        </button>
      </div>
      <div className="record-kind-tabs" role="tablist" aria-label="기록 종류">
        <button
          type="button"
          role="tab"
          aria-selected={kind === "batter"}
          onClick={() => onKindChange("batter")}
        >
          타자 {String(batterCount)}명
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={kind === "pitcher"}
          onClick={() => onKindChange("pitcher")}
        >
          투수 {String(pitcherCount)}명
        </button>
      </div>
      <label className="record-player-filter">
        <span>선수 검색</span>
        <input
          type="search"
          value={query}
          placeholder="이름·팀·선수 ID"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {records.length === 0 ? (
        <p className="muted-text record-detail-empty">
          {query.trim() === ""
            ? `${recordKindLabel(kind)} 기록이 없습니다.`
            : "검색 조건에 맞는 선수 기록이 없습니다."}
        </p>
      ) : (
        <div className="record-detail-body">
          <label className="record-player-select">
            <span>기록 선수</span>
            <select
              value={selected?.recordIdentity ?? ""}
              onChange={(event) => onSelectRecord(event.target.value)}
            >
              {records.map((record) => (
                <option key={record.recordIdentity} value={record.recordIdentity}>
                  {record.teamName} {record.playerName} ({record.playerId})
                  {record.mismatchCount > 0 ? ` · 불일치 ${String(record.mismatchCount)}` : ""}
                </option>
              ))}
            </select>
          </label>
          {selected === undefined ? null : (
            <>
              <article className="record-player-summary">
                <span>
                  {recordKindLabel(selected.kind)} · {selected.teamName}
                </span>
                <h3>{selected.playerName}</h3>
                <p>
                  {selected.battingOrder === undefined
                    ? "타순 미확인"
                    : `${String(selected.battingOrder)}번 타순`}{" "}
                  · 선수 ID {selected.playerId}
                </p>
                <b className={selected.mismatchCount > 0 ? "mismatch" : "match"}>
                  {selected.mismatchCount > 0
                    ? `불일치 ${String(selected.mismatchCount)}개`
                    : "제공된 기록 일치"}
                </b>
              </article>
              <div
                className="record-stat-table"
                role="table"
                aria-label={`${selected.playerName} 기록 비교`}
              >
                <div className="record-stat-header" role="row">
                  <span role="columnheader">항목</span>
                  <span role="columnheader">공식</span>
                  <span role="columnheader">compiler</span>
                  <span role="columnheader">판정</span>
                </div>
                {selected.fields.map((field) => (
                  <div className={`record-stat-row ${field.status}`} role="row" key={field.field}>
                    <strong role="cell">{field.label}</strong>
                    <span role="cell">{recordValue(field.official, "official")}</span>
                    <span role="cell">{recordValue(field.calculated, "calculated")}</span>
                    <em role="cell">{recordStatusLabel(field.status)}</em>
                  </div>
                ))}
              </div>
              <p className="record-comparison-note">
                공식 제공 필드만 검증합니다. compiler가 계산하지 않는 자책점은 비교에서 제외합니다.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function VirtualEventList({
  rows,
  canonicalEvents,
  selectedEventId,
  disabled,
  collapseGroups = new Map(),
  collapsedInningEventIds = new Set(),
  collapsedPlateEventIds = new Set(),
  collapseDisabled = false,
  onSelect,
  onAction,
  onToggleCollapse = () => undefined,
}: {
  readonly rows: readonly CorrectionTimelinePresentation[];
  readonly canonicalEvents: readonly StagingRelayEvent[];
  readonly selectedEventId: string | null;
  readonly disabled: boolean;
  readonly collapseGroups?: ReadonlyMap<string, readonly EventCollapseGroup[]>;
  readonly collapsedInningEventIds?: ReadonlySet<string>;
  readonly collapsedPlateEventIds?: ReadonlySet<string>;
  readonly collapseDisabled?: boolean;
  readonly onSelect: (id: string) => void;
  readonly onAction: (id: string, action: RowAction) => void;
  readonly onToggleCollapse?: (kind: EventCollapseKind, eventId: string) => void;
}): React.JSX.Element {
  const rowHeight = 72;
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [menuOpensUpward, setMenuOpensUpward] = useState(false);
  const selectedIndex = rows.findIndex(
    (row) => row.presentation.event.identity.eventId === selectedEventId,
  );
  const virtualList = useFixedVirtualList({
    itemCount: rows.length,
    rowHeight,
    selectedIndex: selectedIndex < 0 ? null : selectedIndex,
  });
  const { containerRef: listRef, window } = virtualList;
  const visibleRows = rows.slice(window.start, window.end);

  useEffect(() => {
    if (menu === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: MouseEvent): void => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest(".event-more-control") === null
      )
        setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  if (rows.length === 0)
    return <div className="event-list-empty">조건에 맞는 원장 행이 없습니다.</div>;

  const closeMenuAndRestoreFocus = (): void => {
    const current = menu;
    setMenu(null);
    if (current !== null)
      queueMicrotask(() => document.getElementById(menuTriggerId(current))?.focus());
  };
  const toggleMenu = (eventId: string): void => {
    if (menu === eventId) {
      setMenu(null);
      return;
    }
    const list = listRef.current;
    const trigger = document.getElementById(menuTriggerId(eventId));
    if (list !== null && trigger !== null) {
      const listRect = list.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      setMenuOpensUpward(triggerRect.bottom + 132 > listRect.bottom);
    } else setMenuOpensUpward(false);
    setMenu(eventId);
  };
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenuAndRestoreFocus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[target]?.focus();
    }
  };

  return (
    <div
      id="correction-ledger-events"
      ref={listRef}
      className="virtual-event-list"
      aria-label="중계 원장 행"
      onScroll={virtualList.onScroll}
    >
      <ol className="ledger-event-list" style={{ height: window.totalHeight }}>
        {visibleRows.map((row, visibleIndex) => {
          const item = row.presentation;
          const id = item.event.identity.eventId;
          const capabilities = eventMoveCapabilities(canonicalEvents, id);
          const groups = collapseGroups.get(id) ?? [];
          const rowIndex = window.start + visibleIndex;
          const collapsedGroups = groups.filter((group) =>
            group.kind === "inning"
              ? collapsedInningEventIds.has(id)
              : collapsedPlateEventIds.has(id),
          );
          const hiddenCount = collapsedGroups.reduce(
            (maximum, group) => Math.max(maximum, group.childCount),
            0,
          );
          return (
            <li
              key={row.key}
              className={`event-row ${item.startsHalf ? "starts-half" : ""} ${collapsedGroups.length > 0 ? "collapsed-group" : ""} ${selectedEventId === id ? "selected" : ""}`}
              style={{ top: rowIndex * rowHeight, height: rowHeight }}
            >
              <button type="button" className="event-row-select" onClick={() => onSelect(id)}>
                <span className="event-position">
                  <b>{item.location}</b>
                  <small>#{String(item.event.sequence + 1)}</small>
                </span>
                <span className="event-kind-label">{item.kindLabel}</span>
                <span className="event-copy">
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                </span>
                <small className="event-state-line">
                  {item.stateText}
                  {hiddenCount > 0 ? ` · 아래 ${String(hiddenCount)}행 접힘` : ""}
                </small>
              </button>
              <div className="event-row-actions">
                {groups.map((group) => {
                  const collapsed =
                    group.kind === "inning"
                      ? collapsedInningEventIds.has(id)
                      : collapsedPlateEventIds.has(id);
                  return (
                    <IconButton
                      key={group.kind}
                      name={`${group.label} ${group.kind === "inning" ? "이닝" : "타석"} ${collapsed ? "펼치기" : "접기"}`}
                      icon={collapsed ? "expand" : "collapse"}
                      expanded={!collapsed}
                      controls="correction-ledger-events"
                      disabled={disabled || collapseDisabled || group.childCount === 0}
                      onClick={() => {
                        onSelect(id);
                        onToggleCollapse(group.kind, id);
                      }}
                    />
                  );
                })}
                <IconButton
                  name="수정"
                  icon="edit"
                  disabled={disabled}
                  onClick={() => onAction(id, "edit")}
                />
                <IconButton
                  name="위로 이동"
                  icon="up"
                  disabled={disabled || !capabilities.canMoveUp}
                  onClick={() => onAction(id, "move_up")}
                />
                <IconButton
                  name="아래로 이동"
                  icon="down"
                  disabled={disabled || !capabilities.canMoveDown}
                  onClick={() => onAction(id, "move_down")}
                />
                <IconButton
                  name="삭제"
                  icon="delete"
                  danger
                  disabled={disabled}
                  onClick={() => onAction(id, "delete")}
                />
                <div className="event-more-control">
                  <IconButton
                    id={menuTriggerId(id)}
                    controls={menuPanelId(id)}
                    hasPopup
                    name="더보기"
                    icon="more"
                    expanded={menu === id}
                    disabled={disabled}
                    onClick={() => toggleMenu(id)}
                  />
                  {menu === id ? (
                    <div
                      ref={menuRef}
                      id={menuPanelId(id)}
                      role="menu"
                      className={`event-more-menu ${menuOpensUpward ? "opens-upward" : ""}`}
                      onKeyDown={handleMenuKeyDown}
                    >
                      {[
                        ["앞에 행 추가", "insert_before"],
                        ["뒤에 행 추가", "insert_after"],
                        ["위치 지정 이동", "move_to"],
                      ].map(([label, action]) => (
                        <button
                          key={action}
                          role="menuitem"
                          type="button"
                          onClick={() => {
                            setMenu(null);
                            onAction(id, action as RowAction);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function IconButton({
  id,
  name,
  icon,
  danger = false,
  expanded,
  controls,
  hasPopup = false,
  disabled,
  onClick,
}: {
  readonly id?: string;
  readonly name: string;
  readonly icon: "edit" | "up" | "down" | "delete" | "more" | "collapse" | "expand";
  readonly danger?: boolean;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly hasPopup?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  const paths = {
    edit: "M3 13l3-.7 7-7-2.3-2.3-7 7L3 13zm7-9l2.3 2.3",
    up: "M3 10l5-5 5 5",
    down: "M3 6l5 5 5-5",
    delete: "M3 5h10M6 5V3h4v2m-6 0 1 9h6l1-9",
    more: "M3 8h.1M8 8h.1M13 8h.1",
    collapse: "M3 10l5-5 5 5",
    expand: "M3 6l5 5 5-5",
  } as const;
  return (
    <button
      id={id}
      type="button"
      className={`event-action-button ${danger ? "danger" : ""}`}
      aria-label={name}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={hasPopup ? "menu" : undefined}
      title={name}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d={paths[icon]}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

export function EventDetail({
  presentation,
  context,
  findings,
  document,
  eventContexts,
  exceptionTrackingId,
  sourceEvidence,
  sourceEvidencePending,
  sourceEvidenceError,
  pending,
  onApply,
}: {
  readonly presentation: EventPresentation | undefined;
  readonly context: CorrectionEventContext | undefined;
  readonly findings: readonly CorrectionFinding[];
  readonly document: StagingGameDocumentV2;
  readonly eventContexts: readonly CorrectionEventContext[];
  readonly exceptionTrackingId: string | null;
  readonly sourceEvidence: CorrectionSourceEvidence | undefined;
  readonly sourceEvidencePending: boolean;
  readonly sourceEvidenceError: Error | null;
  readonly pending: boolean;
  readonly onApply: (command: CorrectionCommand) => void;
}): React.JSX.Element {
  const event = presentation?.event;
  const exceptionOnly = event === undefined && exceptionTrackingId !== null;
  return (
    <section className="panel correction-detail">
      <div className="panel-title-row">
        <h2>선택한 원장 행</h2>
        <span>{event === undefined ? "-" : eventKindLabel(event.kind)}</span>
      </div>
      {event === undefined || presentation === undefined ? (
        exceptionOnly ? (
          <div className="event-detail-body">
            <p className="muted-text">
              대응하는 원장 투구 행을 찾지 못한 원천 tracking 관측입니다.
            </p>
            <PitchTrackingDetail
              document={document}
              eventContexts={eventContexts}
              pitchEventId={null}
              exceptionTrackingId={exceptionTrackingId}
              pending={pending}
              onApply={onApply}
            />
          </div>
        ) : (
          <p className="muted-text event-detail-body">중계 행을 선택하세요.</p>
        )
      ) : (
        <div className="event-detail-body">
          <article className="event-detail-summary">
            <span>
              {presentation.location} · #{String(event.sequence + 1)} · {presentation.kindLabel}
            </span>
            <h3>{event.relayText ?? "원문 없음"}</h3>
            <p>{presentation.summary}</p>
            {event.kind === "runner_advance" && event.payload.context.kind === "plate_result" ? (
              <small className="movement-parent-reference">
                타석 결과 {event.payload.context.plateResultEventId}에 연결
              </small>
            ) : null}
          </article>
          {context === undefined ? (
            <p className="muted-text">이 행의 compiler 상태를 계산하지 못했습니다.</p>
          ) : (
            <div className="event-state-comparison">
              <div>
                <span>적용 전</span>
                <p>{formatState(context.before, document)}</p>
              </div>
              <b aria-hidden="true">→</b>
              <div>
                <span>적용 후</span>
                <p>{formatState(context.after, document)}</p>
              </div>
              {!context.applied ? (
                <em>blocking finding으로 이 행의 상태 적용이 보류됐습니다.</em>
              ) : null}
            </div>
          )}
          <div className="event-related-findings">
            <div className="panel-title-row">
              <h3>관련 finding</h3>
              <span>{String(findings.length)}건</span>
            </div>
            {findings.length === 0 ? (
              <p className="muted-text">이 행에 직접 연결된 finding이 없습니다.</p>
            ) : (
              findings.map((finding) => {
                const repairable = isRepairableTrackingPlateAppearanceFinding(
                  document,
                  eventContexts,
                  finding,
                );
                return (
                  <article
                    className={finding.severity}
                    key={`${finding.code}:${finding.message}:${finding.eventSequence ?? "game"}`}
                  >
                    <span>
                      {finding.severity === "blocking" ? "차단" : "경고"} · {finding.category}
                    </span>
                    <strong>{finding.message}</strong>
                    <FindingDetails
                      code={finding.code}
                      details={finding.details}
                      recordIdentity={finding.recordIdentity}
                    />
                    {repairable ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={pending}
                        onClick={() =>
                          onApply({
                            commandId: newCommandId(),
                            kind: "reconcile_tracking_plate_appearance_contexts",
                          })
                        }
                      >
                        삭제된 PA 문맥 재계산
                      </button>
                    ) : null}
                    <small>{finding.code}</small>
                  </article>
                );
              })
            )}
          </div>
          {event.kind === "pitch" ? (
            <PitchTrackingDetail
              document={document}
              eventContexts={eventContexts}
              pitchEventId={event.identity.eventId}
              exceptionTrackingId={exceptionTrackingId}
              pending={pending}
              onApply={onApply}
            />
          ) : null}
          <details className="event-technical-details">
            <summary>원천 증거와 정규화 값</summary>
            <dl>
              <div>
                <dt>event ID</dt>
                <dd>{event.identity.eventId}</dd>
              </div>
              <div>
                <dt>원천 위치</dt>
                <dd>{sourceLocation(event)}</dd>
              </div>
              <div>
                <dt>적용 상태</dt>
                <dd>{context === undefined ? "계산 없음" : context.applied ? "적용" : "차단"}</dd>
              </div>
            </dl>
            <h4>정규화 payload</h4>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            {sourceEvidencePending ? (
              <p className="muted-text">원천 행을 불러오는 중입니다.</p>
            ) : null}
            {sourceEvidenceError == null ? null : (
              <p className="inline-error">{sourceEvidenceError.message}</p>
            )}
            {sourceEvidence === undefined ? null : <SourceEvidenceRows evidence={sourceEvidence} />}
          </details>
        </div>
      )}
    </section>
  );
}

function SourceEvidenceRows({
  evidence,
}: {
  readonly evidence: CorrectionSourceEvidence;
}): React.JSX.Element {
  return (
    <div className="source-evidence-rows">
      <h4>선택 행과 앞뒤 원문</h4>
      {evidence.relayRows.map((row) => (
        <article className={row.selected ? "selected" : ""} key={`relay:${String(row.rowIndex)}`}>
          <strong>
            row {String(row.rowIndex)} · seqno{" "}
            {row.sourceSequence === null ? "없음" : String(row.sourceSequence)}
            {row.selected ? " · 선택 행" : ""}
          </strong>
          <pre>{focusedSourceEvidence(row.canonicalJson)}</pre>
          <details>
            <summary>전체 원문 JSON</summary>
            <pre>{prettyCanonicalJson(row.canonicalJson)}</pre>
          </details>
        </article>
      ))}
      <h4>같은 block의 관련 PTS 원문</h4>
      {evidence.trackingRows.length === 0 ? (
        <p className="muted-text">이 행과 같은 sourcePitchId의 PTS 원문이 없습니다.</p>
      ) : (
        evidence.trackingRows.map((row) => (
          <article key={`tracking:${String(row.rowIndex)}`}>
            <strong>
              row {String(row.rowIndex)} · sourcePitchId {row.sourcePitchId ?? "없음"}
            </strong>
            <pre>{prettyCanonicalJson(row.canonicalJson)}</pre>
          </article>
        ))
      )}
    </div>
  );
}

function prettyCanonicalJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

export function OriginalComparisonView({
  comparison,
}: {
  readonly comparison: OriginalComparison;
}): React.JSX.Element {
  return (
    <details className="original-comparison">
      <summary>최초 원장과 비교</summary>
      <div className="original-comparison-summary">
        <span>추가 {String(comparison.eventCounts.added)}</span>
        <span>삭제 {String(comparison.eventCounts.removed)}</span>
        <span>수정 {String(comparison.eventCounts.changed)}</span>
        <span>순서 {String(comparison.eventCounts.moved)}</span>
        <span>명단 {String(comparison.rosterChanges)}</span>
        <span>tracking {String(comparison.trackingChanges)}</span>
        <span>공식 기록 {String(comparison.officialRecordChanges)}</span>
      </div>
      <div className="original-comparison-list">
        {comparison.events.length === 0 ? (
          <p className="muted-text">최초 원장과 다른 이벤트가 없습니다.</p>
        ) : (
          comparison.events.map((difference) => (
            <article
              className={`original-difference ${difference.kind}`}
              key={`${difference.kind}:${difference.eventId}`}
            >
              <header>
                <strong>{differenceKindLabel(difference.kind)}</strong>
                <code>{difference.eventId}</code>
              </header>
              <div>
                <section>
                  <span>최초</span>
                  <small>{sequenceLabel(difference.originalSequence)}</small>
                  <strong>{difference.originalText ?? "없음"}</strong>
                  <small>{difference.originalSummary ?? ""}</small>
                </section>
                <section>
                  <span>현재</span>
                  <small>{sequenceLabel(difference.currentSequence)}</small>
                  <strong>{difference.currentText ?? "없음"}</strong>
                  <small>{difference.currentSummary ?? ""}</small>
                </section>
              </div>
            </article>
          ))
        )}
      </div>
    </details>
  );
}

function findingSearchText(
  finding: DisplayFinding,
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[],
): string {
  const trackingCandidates = trackingCandidatesForFinding(document, finding);
  return [
    finding.message,
    finding.code,
    finding.category,
    finding.severity,
    finding.origin,
    finding.eventId ?? "",
    finding.eventSequence === undefined ? "" : String(finding.eventSequence + 1),
    finding.recordIdentity ?? "",
    recordIdentityLabel(document, finding.recordIdentity) ?? "",
    ...trackingCandidates.flatMap((candidate) => [
      trackingFindingLocation(document, candidate, eventContexts),
      trackingSourceLocation(candidate),
      candidate.sourcePitchId ?? "",
    ]),
    JSON.stringify(finding.details),
  ]
    .join(" ")
    .toLocaleLowerCase("ko-KR");
}

function recordValue(value: number | null | undefined, source: "official" | "calculated"): string {
  if (value === undefined) return source === "official" ? "미제공" : "기록 없음";
  if (value === null) return "계산 제외";
  return String(value);
}

function recordStatusLabel(status: RecordComparisonStatus): string {
  if (status === "match") return "일치";
  if (status === "mismatch") return "불일치";
  if (status === "official_missing") return "공식 미제공";
  if (status === "calculated_missing") return "계산 기록 없음";
  return "검증 제외";
}

function findingOriginLabel(origin: DisplayFinding["origin"]): string {
  if (origin === "both") return "현재·저장 당시";
  return origin === "stored" ? "저장 당시" : "현재";
}

function FindingDetails({
  code,
  details,
  recordIdentity,
}: {
  readonly code: string;
  readonly details: CorrectionFinding["details"];
  readonly recordIdentity: string | undefined;
}): React.JSX.Element | null {
  if (details.length === 0) return null;
  return (
    <ul className="finding-details">
      {details.map((detail, index) => (
        <li key={`${detail.field}:${String(index)}`}>
          {code === "domain.tracking.plate_appearance_mismatch" &&
          detail.field === "plateAppearanceEventId" ? (
            <>
              compiler PA: {findingDetailValue(detail.expected, detail.field)} · tracking PA:{" "}
              {findingDetailValue(detail.actual, detail.field)}
            </>
          ) : (
            <>
              {findingFieldLabel(detail.field, recordIdentity)}: 예상{" "}
              {findingDetailValue(detail.expected, detail.field)}
              {" → "}계산 {findingDetailValue(detail.actual, detail.field)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function findingFieldLabel(field: string, recordIdentity: string | undefined): string {
  const stateLabel = (
    {
      balls: "볼",
      strikes: "스트라이크",
      outs: "아웃",
      awayScore: "원정 점수",
      homeScore: "홈 점수",
      "bases.1": "1루",
      "bases.2": "2루",
      "bases.3": "3루",
    } as Readonly<Record<string, string>>
  )[field];
  if (stateLabel !== undefined) return stateLabel;
  const record = parseOfficialRecordIdentity(recordIdentity);
  return record === null ? field : (recordFieldLabel(record.kind, field) ?? field);
}

function findingDetailValue(
  value: string | number | boolean | null | undefined,
  field: string,
): string {
  if (value === undefined || value === null) return "없음";
  if (field.startsWith("bases.") && typeof value === "boolean") {
    return value ? "점유" : "비어 있음";
  }
  return String(value);
}

function menuTriggerId(eventId: string): string {
  return `event-menu-trigger-${safeId(eventId)}`;
}

function menuPanelId(eventId: string): string {
  return `event-menu-${safeId(eventId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function sourceLocation(event: StagingRelayEvent): string {
  return event.identity.kind === "source"
    ? `${event.identity.endpoint} · block ${String(event.identity.blockIndex)}, row ${String(event.identity.eventIndex)}`
    : "수동 보정 행";
}

function formatState(
  state: CorrectionEventContext["before"],
  document: StagingGameDocumentV2,
): string {
  const names = new Map(
    [...document.rosters.away.players, ...document.rosters.home.players].map((player) => [
      player.playerId,
      player.name,
    ]),
  );
  const bases = state.bases
    .map((runnerId, index) =>
      runnerId === null ? "" : `${String(index + 1)}루 ${names.get(runnerId) ?? runnerId}`,
    )
    .filter(Boolean)
    .join(" · ");
  return `B${String(state.balls)} S${String(state.strikes)} O${String(state.outs)} · ${bases || "주자 없음"} · ${String(state.awayScore)}:${String(state.homeScore)}`;
}

function differenceKindLabel(kind: "added" | "removed" | "changed" | "moved"): string {
  return ({ added: "추가", removed: "삭제", changed: "수정", moved: "순서 변경" } as const)[kind];
}

function sequenceLabel(sequence: number | null): string {
  return sequence === null ? "행 없음" : `${String(sequence + 1)}행`;
}
