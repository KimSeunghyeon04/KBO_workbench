import { useEffect, useMemo, useRef, useState } from "react";
import type { PitchAnalysisPoint, PitchReferenceDistribution } from "@kbo/contracts";
import { createReferenceContours } from "./pitch-reference-geometry";
import { createPitchPlotGeometry, type PlotView } from "./pitch-plot-geometry";
import { groupLabel, pointColor, type ColorMode } from "./pitch-presentation";

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
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = width * ratio;
    element.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    context.font = "12px system-ui, sans-serif";
    context.lineWidth = 1;
    context.strokeStyle = "#dce4df";
    context.strokeRect(1, 1, width - 2, height - 2);
    context.save();
    context.beginPath();
    context.rect(2, 2, width - 4, height - 4);
    context.clip();
    for (const [a, b] of geometry.edges) {
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    if (showReference && referenceGeometry !== null) {
      for (const contour of referenceGeometry.contours) {
        context.strokeStyle = contour.key === "central50" ? "#586d8a" : "#8896a8";
        context.globalAlpha = contour.key === "central50" ? 0.45 : 0.3;
        context.setLineDash(contour.key === "central50" ? [] : [4, 4]);
        for (const line of contour.lines) {
          context.beginPath();
          line.forEach((vector, i) => {
            const p = geometry.project(vector);
            if (i === 0) context.moveTo(p.x, p.y);
            else context.lineTo(p.x, p.y);
          });
          context.stroke();
        }
      }
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    for (const { point, position } of projected) {
      context.globalAlpha = colorMode === "cluster" && point.clusterId === null ? 0.35 : 0.7;
      context.fillStyle = pointColor(point, colorMode, types);
      context.beginPath();
      context.arc(position.x, position.y, width < 500 ? 2.4 : 3.1, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    const active = hover !== null && points.includes(hover) ? hover : selected;
    if (active !== null && points.includes(active)) {
      const p = geometry.project([active.xCm, active.distanceToPlateCm, active.zCm]);
      context.strokeStyle = "#172c21";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(p.x, p.y, 7, 0, 2 * Math.PI);
      context.stroke();
    }
    const origin = geometry.project([0, 0, 0]);
    context.strokeStyle = "#172c21";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(origin.x - 6, origin.y);
    context.lineTo(origin.x + 6, origin.y);
    context.moveTo(origin.x, origin.y - 6);
    context.lineTo(origin.x, origin.y + 6);
    context.stroke();
    context.restore();
    context.fillStyle = "#365341";
    context.textBaseline = "middle";
    context.textAlign = "center";
    const occupied: { x: number; y: number; w: number }[] = [];
    for (const label of geometry.labels) {
      const w = context.measureText(label.text).width;
      const x = Math.max(w / 2 + 5, Math.min(width - w / 2 - 5, label.x));
      const y = Math.max(14, Math.min(height - 14, label.y));
      if (occupied.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 5 && Math.abs(p.y - y) < 18))
        continue;
      occupied.push({ x, y, w });
      context.fillText(label.text, x, y);
    }
  }, [
    points,
    projected,
    selected,
    hover,
    width,
    height,
    geometry,
    colorMode,
    types,
    referenceGeometry,
    showReference,
  ]);
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
  const activeHover = hover !== null && points.includes(hover) ? hover : null;
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
