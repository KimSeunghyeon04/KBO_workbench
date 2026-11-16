// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { PitchAnalysisPoint } from "@kbo/contracts";
import { PitchShapeChart } from "../../apps/web/src/analysis/pitch-shape-chart.js";
import { createPitchPlotGeometry } from "../../apps/web/src/analysis/pitch-plot-geometry.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function point(index: number): PitchAnalysisPoint {
  return {
    gameId: "game",
    revision: 1,
    pitchId: `pitch-${index}`,
    trackingId: `tracking-${index}`,
    gameDate: "2024-04-01",
    pitchType: "직구",
    clusterId: 1,
    speedKph: 140,
    xCm: index % 13,
    zCm: -(index % 31),
    distanceToPlateCm: index % 73,
    arrivalMs: 370,
    timingDifferenceMs: 0,
    extrapolated: false,
    swing: true,
    whiff: false,
    referenceBand: null,
    stadium: null,
    calibrationStatus: "insufficient_data",
    calibrationXcm: null,
    calibrationZcm: null,
  };
}

function contextSpies() {
  return {
    scale: vi.fn(),
    clearRect: vi.fn(),
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
  };
}

function canvasSpies() {
  const contexts = new Map<HTMLCanvasElement, ReturnType<typeof contextSpies>>();
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (element instanceof HTMLCanvasElement) {
      const context = contextSpies();
      contexts.set(element, context);
      Object.defineProperty(element, "getContext", { value: () => context });
    }
    return element;
  });
  return contexts;
}

it("shows the chart and coordinate meaning before collapsed keyboard-accessible view settings", async () => {
  canvasSpies();
  const points = [point(0), point(1), point(2)];
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    createElement(PitchShapeChart, {
      points,
      allPoints: points,
      selected: null,
      colorMode: "provider",
      onSelect,
      referenceDistribution: null,
    }),
  );
  const chart = screen.getByRole("img");
  const summary = screen.getByText("보기 설정");
  const settings = summary.closest("details");
  if (!(settings instanceof HTMLDetailsElement)) throw new Error("Missing view disclosure");
  expect(chart.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(settings.open).toBe(false);
  expect(summary.tagName).toBe("SUMMARY");
  expect(screen.getByText(/평균 포심 = 십자선 · 축별 확대 비율/)).toBeTruthy();
  expect(screen.getByText("X · 좌우 차이 (cm)")).toBeTruthy();
  expect(screen.getByText("Y · 플레이트까지 거리 (cm)")).toBeTruthy();
  expect(screen.getByText("Z · 높이 차이 (cm)")).toBeTruthy();
  const description = document.getElementById(chart.getAttribute("aria-describedby") ?? "");
  expect(description?.textContent).toContain("Y=0: 플레이트 중간면 · +Y: 플레이트 이전");
  expect(description?.textContent).toContain("유효 포심 4구 이상");

  await user.tab();
  expect(document.activeElement).toBe(chart);
  fireEvent.keyDown(chart, { key: "End" });
  expect(onSelect).toHaveBeenLastCalledWith(points[2]);
  fireEvent.keyDown(chart, { key: "Home" });
  expect(onSelect).toHaveBeenLastCalledWith(points[0]);
  await user.tab();
  expect(document.activeElement).toBe(summary);
  await user.click(summary);
  expect(settings.open).toBe(true);
  const yaw = screen.getByRole("slider", { name: "좌우 회전" });
  const elevation = screen.getByRole("slider", { name: "상하 회전" });
  const zoom = screen.getByRole("slider", { name: "확대" });
  expect(yaw).toHaveProperty("min", "-180");
  expect(yaw).toHaveProperty("max", "180");
  expect(elevation).toHaveProperty("min", "-75");
  expect(elevation).toHaveProperty("max", "75");
  expect(zoom).toHaveProperty("min", "0.6");
  expect(zoom).toHaveProperty("max", "2");
  expect(zoom).toHaveProperty("step", "0.1");
  expect(screen.getByRole("checkbox", { name: "시즌 포심 분포 표시" })).toHaveProperty(
    "disabled",
    true,
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "축 비율" }), "equal");
  expect(screen.getByText(/평균 포심 = 십자선 · 동일한 cm 비율/)).toBeTruthy();
  fireEvent.change(yaw, { target: { value: "180" } });
  fireEvent.change(elevation, { target: { value: "-75" } });
  fireEvent.change(zoom, { target: { value: "2" } });
  expect(screen.getByText("180°")).toBeTruthy();
  expect(screen.getByText("-75°")).toBeTruthy();
  expect(screen.getByText("2.0×")).toBeTruthy();
  await user.click(summary);
  expect(settings.open).toBe(false);
  expect(screen.getByText(/동일한 cm 비율/)).toBeTruthy();
  await user.click(summary);
  expect(yaw).toHaveProperty("value", "180");
  await user.click(screen.getByRole("button", { name: "3D 초기 시점" }));
  expect(yaw).toHaveProperty("value", "35");
  expect(elevation).toHaveProperty("value", "18");
  expect(zoom).toHaveProperty("value", "1");
});

it("reuses the 10,000-pitch background for selection and hover while retaining one accessible canvas", () => {
  const contexts = canvasSpies();
  vi.stubGlobal("PointerEvent", MouseEvent);
  const points = Array.from({ length: 10_000 }, (_, index) => point(index));
  const selected = points[0];
  if (selected === undefined) throw new Error("Missing test point");
  const onSelect = vi.fn();
  const props = {
    points,
    allPoints: points,
    colorMode: "provider" as const,
    onSelect,
    referenceDistribution: null,
  };
  const view = render(createElement(PitchShapeChart, { ...props, selected: null }));
  const canvas = screen.getByRole("img");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing chart canvas");
  const main = contexts.get(canvas);
  if (main === undefined) throw new Error("Missing chart context");
  const fills = () =>
    [...contexts.values()].reduce((sum, context) => sum + context.fill.mock.calls.length, 0);
  expect(fills()).toBe(10_000);
  expect(document.querySelectorAll("canvas")).toHaveLength(1);

  view.rerender(createElement(PitchShapeChart, { ...props, selected }));
  expect(fills()).toBe(10_000);
  expect(main.arc).toHaveBeenLastCalledWith(
    expect.any(Number),
    expect.any(Number),
    7,
    0,
    2 * Math.PI,
  );
  expect(main.drawImage).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(canvas, { key: "ArrowRight" });
  expect(onSelect).toHaveBeenLastCalledWith(points[1]);

  const geometry = createPitchPlotGeometry(points, 720, 520, {
    yaw: 35,
    elevation: 18,
    zoom: 1,
    equalScale: false,
  });
  const hovered = points[5];
  if (hovered === undefined) throw new Error("Missing hover point");
  const position = geometry.project([hovered.xCm, hovered.distanceToPlateCm, hovered.zCm]);
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 720, 520));
  fireEvent.pointerMove(canvas, { clientX: position.x, clientY: position.y });
  expect(main.drawImage).toHaveBeenCalledTimes(3);
  expect(fills()).toBe(10_000);
  fireEvent.pointerLeave(canvas);
  expect(main.drawImage).toHaveBeenCalledTimes(4);
  expect(fills()).toBe(10_000);
});

it("rebuilds the background on transforms/data/resize and releases detached bitmaps without stale markers", () => {
  const contexts = canvasSpies();
  vi.stubGlobal("devicePixelRatio", 3);
  let resize: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resize = () =>
          this.callback(
            [
              {
                target,
                contentRect: new DOMRect(0, 0, 320, 200),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this,
          );
      }
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const selected = point(1);
  const points = [selected, point(2)];
  const props = {
    points,
    allPoints: points,
    selected,
    colorMode: "provider" as const,
    onSelect: vi.fn(),
    referenceDistribution: null,
  };
  const view = render(createElement(PitchShapeChart, props));
  const canvas = screen.getByRole("img");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing chart canvas");
  const main = contexts.get(canvas);
  if (main === undefined) throw new Error("Missing chart context");
  const backgrounds = () => [...contexts.keys()].filter((element) => element !== canvas);
  expect(canvas.width).toBe(1440);
  expect(canvas.height).toBe(1040);
  const position = main.arc.mock.lastCall?.slice(0, 2);
  fireEvent.click(screen.getByText("보기 설정"));
  fireEvent.change(screen.getByLabelText("좌우 회전"), { target: { value: "75" } });
  expect(backgrounds()).toHaveLength(2);
  expect(backgrounds()[0]?.width).toBe(0);
  expect(main.arc.mock.lastCall?.slice(0, 2)).not.toEqual(position);
  act(() => resize?.());
  expect(canvas.width).toBe(640);
  expect(canvas.height).toBe(780);
  expect(backgrounds()).toHaveLength(3);

  main.arc.mockClear();
  view.rerender(createElement(PitchShapeChart, { ...props, points: [] }));
  expect(main.arc).not.toHaveBeenCalled();
  expect(backgrounds()).toHaveLength(4);
  view.unmount();
  expect(
    backgrounds().every((background) => background.width === 0 && background.height === 0),
  ).toBe(true);
  expect(disconnect).toHaveBeenCalledTimes(1);
});
