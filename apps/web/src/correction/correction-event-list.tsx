import type { StagingRelayEvent } from "@kbo/contracts";
import { useEffect, useRef, useState } from "react";
import { useFixedVirtualList } from "../components/use-fixed-virtual-list";
import { eventMoveCapabilities } from "./event-actions";
import type { EventCollapseGroup, EventCollapseKind } from "./event-collapse";
import type { CorrectionTimelinePresentation } from "./event-presentation";

export type RowAction =
  "edit" | "move_up" | "move_down" | "delete" | "insert_before" | "insert_after" | "move_to";

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

function menuTriggerId(eventId: string): string {
  return `event-menu-trigger-${safeId(eventId)}`;
}

function menuPanelId(eventId: string): string {
  return `event-menu-${safeId(eventId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
