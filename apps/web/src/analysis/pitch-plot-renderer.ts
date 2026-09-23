import type { PitchAnalysisPoint } from "@kbo/contracts";
import type { createPitchPlotGeometry } from "./pitch-plot-geometry";
import type { createReferenceContours } from "./pitch-reference-geometry";
import { pointColor, type ColorMode } from "./pitch-presentation";

type PlotGeometry = ReturnType<typeof createPitchPlotGeometry>;
export interface PitchPlotScene {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly geometry: PlotGeometry;
  readonly projected: readonly {
    point: PitchAnalysisPoint;
    position: ReturnType<PlotGeometry["project"]>;
  }[];
  readonly colorMode: ColorMode;
  readonly types: readonly string[];
  readonly referenceGeometry: ReturnType<typeof createReferenceContours> | null;
  readonly showReference: boolean;
}

function prepare(canvas: HTMLCanvasElement, scene: PitchPlotScene) {
  const context = canvas.getContext("2d");
  if (context === null) return null;
  canvas.width = scene.width * scene.pixelRatio;
  canvas.height = scene.height * scene.pixelRatio;
  context.scale(scene.pixelRatio, scene.pixelRatio);
  context.clearRect(0, 0, scene.width, scene.height);
  context.font = "12px system-ui, sans-serif";
  return context;
}

function clip(context: CanvasRenderingContext2D, scene: PitchPlotScene) {
  context.save();
  context.beginPath();
  context.rect(2, 2, scene.width - 4, scene.height - 4);
  context.clip();
}

export function renderPitchPlotBackground(canvas: HTMLCanvasElement, scene: PitchPlotScene) {
  const context = prepare(canvas, scene);
  if (context === null) return;
  const { width, height, geometry, projected, colorMode, types, referenceGeometry, showReference } =
    scene;
  context.lineWidth = 1;
  context.strokeStyle = "#dce4df";
  context.strokeRect(1, 1, width - 2, height - 2);
  clip(context, scene);
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
  context.restore();
}

export function renderPitchPlotSelection(
  canvas: HTMLCanvasElement,
  background: HTMLCanvasElement,
  scene: PitchPlotScene,
  active: PitchAnalysisPoint | null,
) {
  const context = prepare(canvas, scene);
  if (context === null) return;
  const { width, height, geometry } = scene;
  context.drawImage(
    background,
    0,
    0,
    background.width / scene.pixelRatio,
    background.height / scene.pixelRatio,
  );
  clip(context, scene);
  context.strokeStyle = "#172c21";
  context.lineWidth = 2;
  if (active !== null) {
    const p = geometry.project([active.xCm, active.distanceToPlateCm, active.zCm]);
    context.beginPath();
    context.arc(p.x, p.y, 7, 0, 2 * Math.PI);
    context.stroke();
  }
  const origin = geometry.project([0, 0, 0]);
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
}
