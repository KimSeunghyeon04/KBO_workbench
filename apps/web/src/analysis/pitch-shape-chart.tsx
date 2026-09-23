import { useEffect, useMemo, useRef, useState } from "react";
import type { PitchAnalysisPoint, PitchReferenceDistribution } from "@kbo/contracts";
import { createReferenceContours } from "./pitch-reference-geometry";
import { createPitchPlotGeometry, type PlotView } from "./pitch-plot-geometry";
import { groupLabel, type ColorMode } from "./pitch-presentation";
import { renderPitchPlotBackground, renderPitchPlotSelection } from "./pitch-plot-renderer";

interface Props {
  readonly points: readonly PitchAnalysisPoint[];
  readonly allPoints: readonly PitchAnalysisPoint[];
  readonly colorMode: ColorMode;
  readonly selected: PitchAnalysisPoint | null;
  readonly onSelect: (point: PitchAnalysisPoint) => void;
  readonly referenceDistribution: PitchReferenceDistribution | null;
}
export function signed(value: number, digits = 1): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
const initialView: PlotView = { yaw: 35, elevation: 18, zoom: 1, equalScale: false };
export function PitchShapeChart({
  points,
  allPoints,
  colorMode,
  selected,
  onSelect,
  referenceDistribution,
}: Props): React.JSX.Element {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const backgroundCanvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number; view: PlotView; moved: boolean } | null>(null);
  const [width, setWidth] = useState(720);
  const [view, setView] = useState(initialView);
  const [hover, setHover] = useState<PitchAnalysisPoint | null>(null);
  const [showReference, setShowReference] = useState(true);
  const referenceGeometry = useMemo(
    () => (referenceDistribution === null ? null : createReferenceContours(referenceDistribution)),
    [referenceDistribution],
  );
  useEffect(() => {
    const element = wrapper.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const height = width < 500 ? 390 : 520;
  const geometry = useMemo(
    () =>
      createPitchPlotGeometry(
        [...allPoints, ...(referenceGeometry?.bounds ?? [])],
        width,
        height,
        view,
      ),
    [allPoints, referenceGeometry, width, height, view],
  );
  const projected = useMemo(
    () =>
      points
        .map((point) => ({
          point,
          position: geometry.project([point.xCm, point.distanceToPlateCm, point.zCm]),
        }))
        .sort((a, b) => b.position.depth - a.position.depth),
    [points, geometry],
  );
  const types = useMemo(
    () => [...new Set(allPoints.map((p) => p.pitchType ?? "구종 미상"))].sort(),
    [allPoints],
  );
  const pixelRatio = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
  const scene = useMemo(
    () => ({
      width,
      height,
      pixelRatio,
      geometry,
      projected,
      colorMode,
      types,
      referenceGeometry,
      showReference,
    }),
    [
      width,
      height,
      pixelRatio,
      geometry,
      projected,
      colorMode,
      types,
      referenceGeometry,
      showReference,
    ],
  );
  const visiblePoints = useMemo(() => new Set(points), [points]);
  const activeHover = hover !== null && visiblePoints.has(hover) ? hover : null;
  const active =
    activeHover ?? (selected !== null && visiblePoints.has(selected) ? selected : null);
  useEffect(() => {
    const background = document.createElement("canvas");
    renderPitchPlotBackground(background, scene);
    backgroundCanvas.current = background;
    return () => {
      backgroundCanvas.current = null;
      background.width = 0;
      background.height = 0;
    };
  }, [scene]);
  useEffect(() => {
    const element = canvas.current;
    const background = backgroundCanvas.current;
    if (element !== null && background !== null)
      renderPitchPlotSelection(element, background, scene, active);
  }, [scene, active]);
  function nearest(event: React.PointerEvent<HTMLCanvasElement>): PitchAnalysisPoint | null {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) * width) / rect.width;
    const py = ((event.clientY - rect.top) * height) / rect.height;
    let distance = 24 ** 2;
    let result: PitchAnalysisPoint | null = null;
    for (const { point, position } of projected) {
      const candidate = (position.x - px) ** 2 + (position.y - py) ** 2;
      if (candidate <= distance) {
        distance = candidate;
        result = point;
      }
    }
    return result;
  }
  return (
    <div className="pitch-shape-chart" ref={wrapper}>
      <div className="pitch-view-controls">
        <div className="pitch-view-presets">
          <button type="button" onClick={() => setView(initialView)}>
            3D 초기 시점
          </button>
          <button type="button" onClick={() => setView({ ...view, yaw: 0, elevation: 0, zoom: 1 })}>
            정면
          </button>
          <label>
            축 비율{" "}
            <select
              aria-label="축 비율"
              value={view.equalScale ? "equal" : "expanded"}
              onChange={(e) => setView({ ...view, equalScale: e.target.value === "equal" })}
            >
              <option value="expanded">축별 확대</option>
              <option value="equal">실제 길이 비율</option>
            </select>
          </label>
        </div>
        <div className="pitch-view-sliders">
          <label>
            좌우 회전 <span>{Math.round(view.yaw)}°</span>
            <input
              aria-label="좌우 회전"
              type="range"
              min="-180"
              max="180"
              value={view.yaw}
              onChange={(e) => setView({ ...view, yaw: Number(e.target.value) })}
            />
          </label>
          <label>
            상하 회전 <span>{Math.round(view.elevation)}°</span>
            <input
              aria-label="상하 회전"
              type="range"
              min="-75"
              max="75"
              value={view.elevation}
              onChange={(e) => setView({ ...view, elevation: Number(e.target.value) })}
            />
          </label>
          <label>
            확대 <span>{view.zoom.toFixed(1)}×</span>
            <input
              aria-label="확대"
              type="range"
              min="0.6"
              max="2"
              step="0.1"
              value={view.zoom}
              onChange={(e) => setView({ ...view, zoom: Number(e.target.value) })}
            />
          </label>
        </div>
      </div>
      <div className="pitch-chart-caption">
        <span>
          3D · 평균 포심 = 십자선 · {view.equalScale ? "동일한 cm 비율" : "축별 확대 비율"}
        </span>
        <span>{points.length.toLocaleString()}구</span>
      </div>
      <div className="pitch-reference-toggle">
        <label>
          <input
            type="checkbox"
            checked={showReference && referenceDistribution !== null}
            disabled={referenceDistribution === null}
            onChange={(event) => setShowReference(event.target.checked)}
          />
          시즌 포심 분포 표시
        </label>
        <span>
          {referenceDistribution === null
            ? "유효 포심 4구 이상부터 분포를 표시합니다."
            : "실선: 중앙 50% · 점선: 중앙 90% · 타원체 내부 기준"}
        </span>
      </div>
      <canvas
        ref={canvas}
        style={{ width: "100%", height }}
        tabIndex={0}
        role="img"
        aria-label={`평균 포심 도착 순간의 3D 투구 ${points.length}개. X 좌우, Y 플레이트까지 거리, Z 높이. 드래그로 회전, 방향키로 공 선택.`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, view, moved: false };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start === null) {
            setHover(nearest(event));
            return;
          }
          const dx = event.clientX - start.x,
            dy = event.clientY - start.y;
          if (Math.hypot(dx, dy) > 5) start.moved = true;
          if (!start.moved) return;
          setHover(null);
          setView({
            ...start.view,
            yaw: ((start.view.yaw + dx * 0.45 + 540) % 360) - 180,
            elevation: Math.max(-75, Math.min(75, start.view.elevation + dy * 0.35)),
          });
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          drag.current = null;
          if (start !== null && !start.moved) {
            const point = nearest(event);
            if (point !== null) onSelect(point);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          setHover(null);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
          )
            return;
          event.preventDefault();
          setHover(null);
          const index = selected === null ? -1 : points.indexOf(selected);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? points.length - 1
                : Math.max(
                    0,
                    Math.min(
                      points.length - 1,
                      index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1),
                    ),
                  );
          const point = points[next];
          if (point !== undefined) onSelect(point);
        }}
      />
      <div className="pitch-axis-key">
        <span>X · 좌우 차이 (cm)</span>
        <span>Y · 플레이트까지 거리 (cm)</span>
        <span>Z · 높이 차이 (cm)</span>
      </div>
      <p className="pitch-hover-readout">
        {activeHover === null
          ? "드래그로 회전 · 점을 눌러 선택 · 방향키로 투구 이동"
          : `${groupLabel(activeHover, colorMode)} · 중계 ${activeHover.pitchType ?? "구종 미상"} · X ${signed(activeHover.xCm)} / Y ${signed(activeHover.distanceToPlateCm)} / Z ${signed(activeHover.zCm)} cm · ${signed(activeHover.timingDifferenceMs)} ms`}
      </p>
    </div>
  );
}
