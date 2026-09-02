// @vitest-environment jsdom

import {
  parseStagingGameDocumentV2,
  type CorrectionCommand,
  type CorrectionEventContext,
} from "@kbo/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PitchTrackingDetail } from "../../apps/web/src/correction/pitch-tracking-detail.js";

afterEach(() => cleanup());

describe("투구 상세 tracking", () => {
  it("자동 연결된 관측은 원천 위치·PTS 순번·metric만 보여주고 교정 버튼을 숨긴다", () => {
    const document = repeatedSourceFixture();
    render(
      createElement(PitchTrackingDetail, {
        document,
        eventContexts: contexts(),
        pitchEventId: "anon-pitch",
        exceptionTrackingId: null,
        pending: false,
        onApply: vi.fn(),
      }),
    );

    expect(screen.getByText("relay_005 · block 6 · row 1")).toBeTruthy();
    expect(screen.getByText("투구에 연결")).toBeTruthy();
    expect(screen.getByText("PTS 순번").nextElementSibling?.textContent).toBe("1");
    expect(screen.queryByRole("button", { name: /연결|제외/ })).toBeNull();
  });

  it("실제 pending 충돌이 있을 때만 선택한 투구의 연결·제외 조작을 표시한다", async () => {
    const fixture = repeatedSourceFixture();
    const document = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: fixture.trackingCandidates.map((candidate) => ({
        ...candidate,
        resolution: { kind: "pending" as const },
      })),
    });
    const onApply = vi.fn<(command: CorrectionCommand) => void>();
    render(
      createElement(PitchTrackingDetail, {
        document,
        eventContexts: contexts(),
        pitchEventId: "anon-pitch",
        exceptionTrackingId: "anon-tracking-a",
        pending: false,
        onApply,
      }),
    );

    expect(screen.getAllByText("미해결")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /대표/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "이 관측값을 투구에 연결" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "link_tracking_candidate",
        trackingId: "anon-tracking-a",
        pitchEventId: "anon-pitch",
      }),
    );
  });

  it("대응 투구가 없는 pending 관측은 우측 예외에서 연결 후보를 고를 수 있다", () => {
    const fixture = repeatedSourceFixture();
    const orphan = parseStagingGameDocumentV2({
      ...fixture,
      trackingCandidates: [
        {
          ...fixture.trackingCandidates[0],
          trackingId: "orphan-tracking",
          sourcePitchId: "orphan-source-id",
          resolution: { kind: "pending" },
        },
      ],
    });
    render(
      createElement(PitchTrackingDetail, {
        document: orphan,
        eventContexts: contexts(),
        pitchEventId: null,
        exceptionTrackingId: "orphan-tracking",
        pending: false,
        onApply: vi.fn(),
      }),
    );

    expect(screen.getByRole("combobox", { name: "orphan-tracking 연결 투구" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "공급자 충돌로 제외" })).toBeTruthy();
  });
});

function repeatedSourceFixture() {
  return parseStagingGameDocumentV2(
    JSON.parse(
      readFileSync("tests/fixtures/tracking-duplicate-review.anonymized.json", "utf8"),
    ) as unknown,
  );
}

function contexts(): CorrectionEventContext[] {
  return [
    pitchContext("anon-pitch", "anon-pa", 1),
    pitchContext("anon-pitch-repeat", "anon-pa-repeat", 1),
  ];
}

function pitchContext(
  eventId: string,
  plateAppearanceEventId: string,
  actualPitchNumber: number,
): CorrectionEventContext {
  return {
    eventId,
    applied: true,
    before: state(),
    after: { ...state(), strikes: 1 },
    pitch: {
      plateAppearanceEventId,
      pitchEventNumber: actualPitchNumber,
      actualPitchNumber,
      batterId: "anon-batter",
      pitcherId: "anon-pitcher",
      sourcePitchId: "anon-source-pitch",
      call: "called_strike",
      actual: true,
    },
  };
}

function state(): CorrectionEventContext["before"] {
  return {
    balls: 0,
    strikes: 0,
    outs: 0,
    bases: [null, null, null],
    awayScore: 0,
    homeScore: 0,
    batterId: "anon-batter",
    pitcherId: "anon-pitcher",
  };
}
