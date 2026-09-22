import { describe, expect, it } from "vitest";

import {
  nextReplayIndex,
  replayDelay,
  strikeZonePlot,
} from "../../apps/web/src/replay/playback.js";
import { plateTracking as tracking, plateZoneCases } from "../helpers/tracking-geometry.js";

describe("browser replay playback", () => {
  it.each(plateZoneCases)("plate geometry: $label", ({ overrides, inZone }) => {
    const plot = strikeZonePlot(tracking(overrides));
    const inside =
      plot === null
        ? null
        : Math.abs(plot.xFeet) <= plot.halfWidthFeet &&
          plot.zFeet >= plot.bottomFeet &&
          plot.zFeet <= plot.topFeet;
    expect(inside).toBe(inZone);
  });
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
    expect(strikeZonePlot({ ...tracking(), strikeZone: null })).toBeNull();
  });

  it("같은 plate y 기준에서도 투구 궤적에 따라 z 높이가 달라진다", () => {
    const low = strikeZonePlot(tracking());
    const high = strikeZonePlot({ ...tracking(), z0: 6.28675 });

    expect(low?.zFeet).toBeCloseTo(2.6827, 3);
    expect(high?.zFeet).toBeCloseTo(3.1827, 3);
    expect(high?.zFeet).not.toBe(low?.zFeet);
  });
});
