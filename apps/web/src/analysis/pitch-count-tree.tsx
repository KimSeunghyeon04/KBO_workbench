import { useId, useLayoutEffect, useRef, useState } from "react";
import type { PitchCountFlowGroup, PitchCountOutcome } from "@kbo/contracts";
import { outcomePercent } from "./pitch-outcome-presentation";

const width = 382;
const height = 503;
export const pitchCounts = Array.from({ length: 12 }, (_, key) => {
  const balls = key % 4;
  const strikes = Math.floor(key / 4);
  return { key, balls, strikes, x: 181 + (strikes - balls) * 44, y: 44 + (balls + strikes) * 85 };
});
export type PitchCount = (typeof pitchCounts)[number];
export type PitchType = string | null;
export type PitchSelection = PitchType | undefined;
type TypeGroup = PitchCountFlowGroup["types"][number];
type Summary = Pick<PitchCountFlowGroup, "pitches" | "transitions" | "terminalDetails">;
const markers = ["ball", "strike", "foul"] as const;
const endings = {
  walk: { x: 27, y: 429, label: "볼넷", kind: "ball" },
  strikeout: { x: 350, y: 384, label: "삼진", kind: "strike" },
} as const;

export function countText(count: PitchCount) {
  return `${count.balls}–${count.strikes}`;
}

export function countFlowSample(
  group: PitchCountFlowGroup | undefined,
  selectedPitch: PitchSelection,
): Summary | undefined {
  return selectedPitch === undefined
    ? group
    : group?.types.find((type) => type.pitchType === selectedPitch);
}

function compactRate(rate: number | null) {
  if (rate === null) return "—";
  if (rate > 0 && rate < 0.005) return "<1%";
  return `${Math.round(rate * 100)}%`;
}

function RouteRate({ x, y, rate }: { x: number; y: number; rate: number | null }) {
  return (
    <text x={x} y={y}>
      <tspan className="pitch-flow-rate">{outcomePercent(rate)}</tspan>
      <tspan className="pitch-flow-rate-compact">{compactRate(rate)}</tspan>
    </text>
  );
}

function FlowRoutes({
  groups,
  selectedPitch,
}: {
  groups: ReadonlyMap<number, PitchCountFlowGroup>;
  selectedPitch: PitchSelection;
}) {
  const id = useId();
  const marker = (kind: (typeof markers)[number]) => `url(#${id}-${kind})`;
  return (
    <svg className="pitch-flow-routes" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        {markers.map((kind) => (
          <marker
            key={kind}
            id={`${id}-${kind}`}
            className={`pitch-flow-${kind}`}
            viewBox="0 0 7 8"
            refX="6"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M0 0 L7 4 L0 8 Z" />
          </marker>
        ))}
      </defs>
      {pitchCounts.map((from) => {
        const sample = countFlowSample(groups.get(from.key), selectedPitch);
        const rate = (outcome: PitchCountOutcome) =>
          sample?.transitions.find((row) => row.outcome === outcome)?.rate ?? null;
        const nextBall = from.balls < 3 ? pitchCounts[from.key + 1] : undefined;
        const nextStrike = from.strikes < 2 ? pitchCounts[from.key + 4] : undefined;
        const outcomes = [
          { kind: "ball", to: nextBall ?? endings.walk, outcome: nextBall ? "ball" : "walk" },
          {
            kind: "strike",
            to: nextStrike ?? endings.strikeout,
            outcome: nextStrike ? "strike" : "strikeout",
          },
        ] as const;
        return (
          <g key={from.key} className={sample === undefined ? "pitch-flow-unavailable" : undefined}>
            {outcomes.map(({ kind, to, outcome }) => {
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const distance = Math.hypot(dx, dy);
              const terminal = outcome === "walk" || outcome === "strikeout";
              const fraction =
                outcome === "strikeout" && from.balls === 0
                  ? 0.23
                  : outcome === "strikeout" && from.balls === 2
                    ? 0.62
                    : 0.5;
              const labelX =
                from.x + dx * fraction + (outcome === "walk" && from.strikes === 0 ? 16 : 0);
              const labelOffset =
                outcome === "strikeout" && from.balls === 2
                  ? 13
                  : outcome === "walk" && from.strikes === 2
                    ? 12
                    : -10;
              return (
                <g
                  key={outcome}
                  data-from={countText(from)}
                  data-outcome={outcome}
                  className={`pitch-flow-route pitch-flow-${kind}${terminal ? " pitch-flow-terminal-route" : ""}`}
                >
                  <line
                    x1={from.x + (dx / distance) * 21}
                    y1={from.y + (dy / distance) * 21}
                    x2={to.x - (dx / distance) * 23}
                    y2={to.y - (dy / distance) * 23}
                    markerEnd={marker(kind)}
                  />
                  <RouteRate
                    x={labelX}
                    y={from.y + dy * fraction + labelOffset}
                    rate={rate(outcome)}
                  />
                </g>
              );
            })}
            {from.strikes === 2 && (
              <g
                className="pitch-flow-route pitch-flow-foul"
                data-from={countText(from)}
                data-outcome="foul"
              >
                <path
                  d={`M ${from.x + 20} ${from.y - 7} C ${from.x + 48} ${from.y - 7}, ${from.x + 38} ${from.y - 48}, ${from.x + 16} ${from.y - 17}`}
                  markerEnd={marker("foul")}
                />
                <RouteRate x={from.x + 56} y={from.y - 24} rate={rate("foul")} />
              </g>
            )}
          </g>
        );
      })}
      {Object.entries(endings).map(([key, end]) => (
        <g key={key} className={`pitch-flow-ending pitch-flow-${end.kind}`}>
          <circle cx={end.x} cy={end.y} r={21} />
          <text x={end.x} y={end.y}>
            {end.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function Pie({
  types,
  colors,
  selectedPitch,
}: {
  types: readonly TypeGroup[];
  colors: ReadonlyMap<PitchType, string>;
  selectedPitch: PitchSelection;
}) {
  const point = (angle: number) => `${22 + 21 * Math.cos(angle)} ${22 + 21 * Math.sin(angle)}`;
  let share = 0;
  return (
    <svg viewBox="0 0 44 44" className="pitch-flow-pie" aria-hidden="true">
      {types.length === 0 && <circle cx={22} cy={22} r={21} className="pitch-flow-empty-node" />}
      {types.map((type, index) => {
        const start = share * Math.PI * 2 - Math.PI / 2;
        share += type.usageRate;
        const end = share * Math.PI * 2 - Math.PI / 2;
        const props = {
          fill: colors.get(type.pitchType),
          className:
            selectedPitch !== undefined && type.pitchType !== selectedPitch
              ? "pitch-flow-dim"
              : undefined,
          "data-pitch-index": index,
        };
        const key = JSON.stringify(type.pitchType);
        return type.usageRate === 1 ? (
          <circle key={key} cx={22} cy={22} r={21} {...props} />
        ) : (
          <path
            key={key}
            d={`M22 22 L${point(start)} A21 21 0 ${type.usageRate > 0.5 ? 1 : 0} 1 ${point(end)} Z`}
            {...props}
          />
        );
      })}
    </svg>
  );
}

export function PitchCountTree({
  label,
  groups,
  colors,
  selectedPitch,
  onInspect,
  onSelect,
}: {
  label: string;
  groups: ReadonlyMap<number, PitchCountFlowGroup>;
  colors: ReadonlyMap<PitchType, string>;
  selectedPitch: PitchSelection;
  onInspect: (key: number) => void;
  onSelect: (key: number, pitch: PitchSelection) => void;
}) {
  const [open, setOpen] = useState<{
    count: PitchCount;
    mode: "hover" | "tap" | "keyboard";
  } | null>(null);
  const pointerType = useRef("mouse");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pickerId = useId();
  useLayoutEffect(() => {
    if (open?.mode === "keyboard")
      picker.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [open]);
  const openTypes = open === null ? undefined : groups.get(open.count.key)?.types;
  const openX = open === null ? 0 : (open.count.x / width) * 100;
  const pickerOnLeft = openX > 50;
  const pickerOffset = pickerOnLeft ? 100 - openX : openX;
  function select(key: number, pitch: PitchSelection) {
    trigger.current?.focus({ preventScroll: true });
    setOpen(null);
    onSelect(key, pitch);
  }
  return (
    <figure
      className="pitch-flow-tree"
      aria-label={label}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open !== null) {
          event.stopPropagation();
          trigger.current?.focus({ preventScroll: true });
          setOpen(null);
        }
      }}
    >
      <figcaption>{label}</figcaption>
      <div className="pitch-flow-canvas">
        <FlowRoutes groups={groups} selectedPitch={selectedPitch} />
        {pitchCounts.map((count) => {
          const types = groups.get(count.key)?.types ?? [];
          const expanded = open?.count.key === count.key;
          const position = {
            left: `${(count.x / width) * 100}%`,
            top: `${(count.y / height) * 100}%`,
          };
          const countLabel = `${label} ${count.balls}볼 ${count.strikes}스트라이크`;
          return (
            <div
              key={count.key}
              className="pitch-flow-node-target"
              onPointerEnter={(event) => {
                if (
                  event.pointerType === "touch" ||
                  types.length === 0 ||
                  (expanded && open.mode !== "hover")
                )
                  return;
                const button =
                  event.target instanceof Element ? event.target.closest("button") : null;
                if (!(button instanceof HTMLButtonElement)) return;
                trigger.current = button;
                setOpen({ count, mode: "hover" });
              }}
              onPointerLeave={() => {
                setOpen((current) =>
                  current?.mode === "hover" && current.count.key === count.key ? null : current,
                );
              }}
            >
              <button
                type="button"
                className="pitch-flow-node"
                style={position}
                aria-label={`${countLabel} 구종 비중`}
                aria-expanded={expanded}
                aria-controls={expanded ? pickerId : undefined}
                disabled={types.length === 0}
                onPointerDown={(event) => {
                  pointerType.current = event.pointerType;
                }}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  const wedge =
                    event.target instanceof Element
                      ? event.target.closest("[data-pitch-index]")
                      : null;
                  const index = wedge?.getAttribute("data-pitch-index");
                  const type =
                    index === undefined || index === null ? undefined : types[Number(index)];
                  if (expanded && type) {
                    select(count.key, type.pitchType);
                  } else {
                    onInspect(count.key);
                    const mode =
                      event.detail === 0
                        ? "keyboard"
                        : pointerType.current === "touch"
                          ? "tap"
                          : "hover";
                    setOpen({ count, mode });
                  }
                }}
              >
                <span className="pitch-flow-count" aria-hidden="true">
                  {countText(count)}
                </span>
                <Pie types={types} colors={colors} selectedPitch={selectedPitch} />
              </button>
              {types.length > 0 && (
                <button
                  type="button"
                  className="pitch-flow-node-center"
                  style={position}
                  aria-label={`${countLabel} 전체 구종 상세`}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    select(count.key, undefined);
                  }}
                />
              )}
            </div>
          );
        })}
        {open !== null && openTypes !== undefined && (
          <div
            ref={picker}
            id={pickerId}
            className="pitch-flow-picker"
            inert={open.mode === "hover"}
            style={{
              [pickerOnLeft ? "right" : "left"]:
                `calc(${pickerOffset}% + var(--pitch-flow-picker-gap))`,
              maxWidth: `calc(${100 - pickerOffset}% - var(--pitch-flow-picker-gap))`,
              top: `clamp(0px, calc(${(open.count.y / height) * 100}% - 32px), calc(100% - 210px))`,
            }}
          >
            <strong>{countText(open.count)} 구종 비중</strong>
            {openTypes.map((type) => (
              <button
                key={JSON.stringify(type.pitchType)}
                type="button"
                aria-label={`${type.pitchType ?? "구종 미상"} ${outcomePercent(type.usageRate)}`}
                aria-pressed={type.pitchType === selectedPitch}
                onClick={() => select(open.count.key, type.pitchType)}
              >
                <i aria-hidden="true" style={{ background: colors.get(type.pitchType) }} />
                <span>{type.pitchType ?? "구종 미상"}</span>
                <b>{outcomePercent(type.usageRate)}</b>
              </button>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
