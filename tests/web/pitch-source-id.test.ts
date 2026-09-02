import type { StagingRelayEvent } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import {
  sameKnownSourcePitchId,
  sourcePitchIdFields,
  sourcePitchIdLabel,
  withPitchSourceId,
} from "../../apps/web/src/correction/pitch-source-id.js";

type PitchEvent = Extract<StagingRelayEvent, { readonly kind: "pitch" }>;

describe("correction pitch source ID", () => {
  it("빈 입력은 필드를 만들지 않고 실제 ID만 trim해 저장한다", () => {
    expect(sourcePitchIdFields("")).toEqual({});
    expect(sourcePitchIdFields("   ")).toEqual({});
    expect(sourcePitchIdFields("  naver-pitch-1  ")).toEqual({
      sourcePitchId: "naver-pitch-1",
    });
  });

  it("수정 입력을 비우면 기존 sourcePitchId를 제거한다", () => {
    const event = pitch("naver-pitch-1", "0198f47a-1234-7abc-8def-1234567890ab");

    const changed = withPitchSourceId(event, "");

    expect(changed.payload).not.toHaveProperty("sourcePitchId");
    expect(changed.payload.call).toBe("ball");
  });

  it("ID 없는 투구끼리는 같은 원천 투구로 보지 않는다", () => {
    const left = pitch(undefined, "0198f47a-1234-7abc-8def-1234567890ab");
    const right = pitch(undefined, "0198f47a-1234-7abc-8def-1234567890ac");
    const same = pitch("known", "0198f47a-1234-7abc-8def-1234567890ad");
    const sameOther = pitch("known", "0198f47a-1234-7abc-8def-1234567890ae");

    expect(sameKnownSourcePitchId(left, right)).toBe(false);
    expect(sameKnownSourcePitchId(same, sameOther)).toBe(true);
    expect(sourcePitchIdLabel(undefined)).toBe("원천 ID 없음");
  });
});

function pitch(sourcePitchId: string | undefined, eventId: string): PitchEvent {
  return {
    identity: { kind: "manual", eventId },
    sequence: 0,
    inning: 1,
    half: "top",
    kind: "pitch",
    payload: { call: "ball", ...(sourcePitchId === undefined ? {} : { sourcePitchId }) },
  };
}
