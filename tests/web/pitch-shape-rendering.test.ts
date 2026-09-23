// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
