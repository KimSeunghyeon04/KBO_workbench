import { useMemo } from "react";
import * as React from "react";

import { useFixedVirtualList } from "./use-fixed-virtual-list";

export function SelectableVirtualList<Item>({
  ariaLabel,
  emptyMessage,
  getKey,
  items,
  onSelect,
  renderItem,
  rowHeight,
  selectedKey,
}: {
  readonly ariaLabel: string;
  readonly emptyMessage: string;
  readonly getKey: (item: Item) => string;
  readonly items: readonly Item[];
  readonly onSelect: (item: Item) => void;
  readonly renderItem: (item: Item) => React.ReactNode;
  readonly rowHeight: number;
  readonly selectedKey: string | null;
}): React.JSX.Element {
  const selectedIndex = useMemo(
    () => items.findIndex((item) => getKey(item) === selectedKey),
    [getKey, items, selectedKey],
  );
  const virtual = useFixedVirtualList({
    itemCount: items.length,
    rowHeight,
    selectedIndex: selectedIndex < 0 ? null : selectedIndex,
    initialViewportHeight: 520,
  });
  const visible = items.slice(virtual.window.start, virtual.window.end);

  const selectIndex = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    onSelect(item);
    virtual.scrollToIndex(index);
  };

  return (
    <div
      ref={virtual.containerRef}
      className="selectable-virtual-list"
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={selectedKey === null ? undefined : `operation-option-${selectedKey}`}
      tabIndex={0}
      onKeyDown={(event) => {
        const fallback = selectedIndex < 0 ? 0 : selectedIndex;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          selectIndex(Math.min(fallback + 1, items.length - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          selectIndex(Math.max(fallback - 1, 0));
        } else if (event.key === "Home") {
          event.preventDefault();
          selectIndex(0);
        } else if (event.key === "End") {
          event.preventDefault();
          selectIndex(items.length - 1);
        }
      }}
      onScroll={virtual.onScroll}
    >
      {items.length === 0 ? (
        <p className="muted-text operation-list-empty">{emptyMessage}</p>
      ) : (
        <div className="selectable-virtual-spacer" style={{ height: virtual.window.totalHeight }}>
          {visible.map((item, offset) => {
            const index = virtual.window.start + offset;
            const key = getKey(item);
            const selected = key === selectedKey;
            return (
              <button
                type="button"
                id={`operation-option-${key}`}
                role="option"
                aria-posinset={index + 1}
                aria-setsize={items.length}
                aria-selected={selected}
                className={selected ? "operation-list-row selected" : "operation-list-row"}
                style={{
                  height: rowHeight,
                  transform: `translateY(${String(index * rowHeight)}px)`,
                }}
                key={key}
                onClick={() => onSelect(item)}
              >
                {renderItem(item)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
