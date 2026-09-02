import { describe, expect, it } from "vitest";

import {
  nextReplayIndex,
  replayDelay,
  strikeZonePlot,
} from "../../apps/web/src/replay/playback.js";
import type { ReplayTrackingCandidate } from "@kbo/contracts";

describe("browser replay playback", () => {
  it("서버 상태 없이 로컬 frame index만 경계 안에서 전진시킨다", () => {
    expect(nextReplayIndex(-1, 3)).toBe(0);
    expect(nextReplayIndex(0, 3)).toBe(1);
    expect(nextReplayIndex(2, 3)).toBe(2);
    expect(nextReplayIndex(0, 0)).toBe(-1);
    expect(replayDelay(2)).toBe(600);
  });

  it("wide typed 통과 좌표와 타자별 zone 경계를 그대로 그린다", () => {
    const plot = strikeZonePlot(tracking());
    expect(plot).not.toBeNull();
    expect(plot?.xFeet).toBeCloseTo(0.016251);
    expect(plot?.zFeet).toBeCloseTo(2.6827, 3);
    expect(strikeZonePlot({ ...tracking(), crossPlateY: null })).toBeNull();
    expect(strikeZonePlot({ ...tracking(), z0: null })).toBeNull();
    expect(strikeZonePlot({ ...tracking(), bottomSz: 3, topSz: 2 })).toBeNull();
  });

  it("같은 plate y 기준에서도 투구 궤적에 따라 z 높이가 달라진다", () => {
    const low = strikeZonePlot(tracking());
    const high = strikeZonePlot({ ...tracking(), z0: 6.28675 });

    expect(low?.zFeet).toBeCloseTo(2.6827, 3);
    expect(high?.zFeet).toBeCloseTo(3.1827, 3);
    expect(high?.zFeet).not.toBe(low?.zFeet);
  });
});

function tracking(): ReplayTrackingCandidate {
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
    topSz: 3.067,
    bottomSz: 1.504,
  };
}
