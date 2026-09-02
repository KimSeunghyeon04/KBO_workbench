import { describe, expect, it } from "vitest";

import { calculateVirtualWindow } from "../../apps/web/src/components/virtual-window.js";

describe("event virtual window", () => {
  it("10,000개 event에서도 viewport와 overscan 범위만 선택한다", () => {
    const first = calculateVirtualWindow(10_000, 46, 480, 0);
    const middle = calculateVirtualWindow(10_000, 46, 480, 46 * 5_000);
    const last = calculateVirtualWindow(10_000, 46, 480, 46 * 10_000);

    expect(first).toEqual({ start: 0, end: 17, offsetTop: 0, totalHeight: 460_000 });
    expect(middle.end - middle.start).toBeLessThanOrEqual(24);
    expect(middle.start).toBe(4_994);
    expect(last.end).toBe(10_000);
    expect(last.end - last.start).toBeLessThanOrEqual(7);
  });

  it("잘못된 크기를 거부하고 음수 scroll은 0으로 정규화한다", () => {
    expect(calculateVirtualWindow(10, 46, 480, -100).start).toBe(0);
    expect(() => calculateVirtualWindow(-1, 46, 480, 0)).toThrow("itemCount");
    expect(() => calculateVirtualWindow(1, 0, 480, 0)).toThrow("rowHeight");
  });
});
