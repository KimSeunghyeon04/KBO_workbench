export interface VirtualWindow {
  readonly start: number;
  readonly end: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export function calculateVirtualWindow(
  itemCount: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
  overscan = 6,
): VirtualWindow {
  if (!Number.isInteger(itemCount) || itemCount < 0)
    throw new Error("itemCount가 올바르지 않습니다.");
  if (!Number.isFinite(rowHeight) || rowHeight <= 0)
    throw new Error("rowHeight가 올바르지 않습니다.");
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new Error("viewportHeight가 올바르지 않습니다.");
  }
  if (!Number.isInteger(overscan) || overscan < 0) throw new Error("overscan이 올바르지 않습니다.");

  const normalizedScroll = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const start = Math.max(0, Math.floor(normalizedScroll / rowHeight) - overscan);
  const end = Math.min(
    itemCount,
    Math.ceil((normalizedScroll + viewportHeight) / rowHeight) + overscan,
  );
  return { start, end, offsetTop: start * rowHeight, totalHeight: itemCount * rowHeight };
}
