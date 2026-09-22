import { resolveBatterStrikeZone } from "@kbo/game-core";
import type { ReplayTrackingCandidate } from "@kbo/contracts";

export function plateTracking(
  overrides: Partial<ReplayTrackingCandidate> = {},
): ReplayTrackingCandidate {
  return {
    trackingId: "tracking-1",
    sourcePitchId: "source-1",
    pitchEventId: "pitch-1",
    sourcePitchOrdinal: 1,
    sequence: 0,
    pitcher: null,
    batter: null,
    observedAt: null,
    stance: null,
    x0: null,
    y0: 50,
    z0: 5.78675,
    vx0: null,
    vy0: -129.265,
    vz0: -4.59198,
    ax: null,
    ay: 23.8626,
    az: -16.4274,
    crossPlateX: 0.016251,
    crossPlateY: 0.7083,
    strikeZone: resolveBatterStrikeZone(2026, 168),
    ...overrides,
  };
}

interface ZoneCase {
  readonly label: string;
  readonly overrides: Partial<ReplayTrackingCandidate>;
  readonly inZone: boolean | null;
}

export const plateZoneCases: readonly ZoneCase[] = [
  { label: "plate y is not height", overrides: {}, inZone: true },
  { label: "same plate y, higher trajectory", overrides: { z0: 6.28675 }, inZone: false },
  { label: "same plate y, lower trajectory", overrides: { z0: 4.28675 }, inZone: false },
  { label: "lateral boundary", overrides: { crossPlateX: -(47.18 / 2 / 30.48) }, inZone: true },
  { label: "outside lateral boundary", overrides: { crossPlateX: 0.83 }, inZone: false },
  {
    label: "linear trajectory at bottom boundary",
    overrides: { ay: 0, az: 0, vz0: 0, z0: (168 * 0.2704) / 30.48 },
    inZone: true,
  },
  {
    label: "linear trajectory at top boundary",
    overrides: { ay: 0, az: 0, vz0: 0, z0: (168 * 0.5575) / 30.48 },
    inZone: true,
  },
  { label: "missing trajectory", overrides: { z0: null }, inZone: null },
  { label: "missing plate position", overrides: { crossPlateY: null }, inZone: null },
  { label: "no real crossing", overrides: { vy0: 0, ay: 1 }, inZone: null },
  { label: "crossing only in the past", overrides: { vy0: 100, ay: 0 }, inZone: null },
  { label: "stationary away from plate", overrides: { vy0: 0, ay: 0 }, inZone: null },
  {
    label: "stationary at plate",
    overrides: { y0: 0.7083, z0: 2.5, vy0: 0, ay: 0 },
    inZone: true,
  },
  { label: "below ground", overrides: { z0: -10 }, inZone: null },
  { label: "missing batter height", overrides: { strikeZone: null }, inZone: null },
  { label: "nonfinite trajectory", overrides: { az: Infinity }, inZone: null },
  { label: "nonfinite lateral position", overrides: { crossPlateX: NaN }, inZone: null },
  { label: "overflowing trajectory", overrides: { vy0: -1e308 }, inZone: null },
];
