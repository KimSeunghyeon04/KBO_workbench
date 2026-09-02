import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { calculateVirtualWindow, type VirtualWindow } from "./virtual-window";

export interface FixedVirtualListOptions {
  readonly itemCount: number;
  readonly rowHeight: number;
  readonly selectedIndex?: number | null;
  readonly initialViewportHeight?: number;
  readonly overscan?: number;
}

export interface FixedVirtualList {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly window: VirtualWindow;
  readonly onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  readonly scrollToIndex: (index: number) => void;
}

export function useFixedVirtualList({
  itemCount,
  rowHeight,
  selectedIndex = null,
  initialViewportHeight = 480,
  overscan = 6,
}: FixedVirtualListOptions): FixedVirtualList {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);
  const window = useMemo(
    () => calculateVirtualWindow(itemCount, rowHeight, viewportHeight, scrollTop, overscan),
    [itemCount, overscan, rowHeight, scrollTop, viewportHeight],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const updateHeight = (): void => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scrollToIndex = useCallback(
    (index: number): void => {
      const element = containerRef.current;
      if (element === null || index < 0 || index >= itemCount) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + element.clientHeight) {
        element.scrollTop = bottom - element.clientHeight;
      }
      setScrollTop(element.scrollTop);
    },
    [itemCount, rowHeight],
  );

  useEffect(() => {
    if (selectedIndex !== null) scrollToIndex(selectedIndex);
  }, [scrollToIndex, selectedIndex]);

  return {
    containerRef,
    window,
    onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
    scrollToIndex,
  };
}
