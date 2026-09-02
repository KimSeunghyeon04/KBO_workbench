import { describe, expect, it } from "vitest";

import {
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type TrackingCandidate,
} from "@kbo/contracts";
import { applyCorrectionCommand } from "@kbo/correction";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import { makeDocument } from "../helpers/game-document.js";

describe("V2 tracking resolution", () => {
  it("pending 후보는 값이 같아도 대표 선택 요구 대신 개별 미해결로 차단한다", () => {
    const document = withCandidates([
      candidate("t1", 0, "e2", 1, { kind: "pending" }),
      candidate("t2", 1, "e2", 1, { kind: "pending" }),
    ]);
    const findings = compileStagingGameDocumentV2(document).findings;

    expect(findings.filter((finding) => finding.code === "source.tracking.pending")).toHaveLength(
      2,
    );
    expect(findings.some((finding) => finding.code === "source.tracking.duplicate_exact")).toBe(
      false,
    );
    expect(document.trackingCandidates.map((item) => item.resolution.kind)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("같은 sourcePitchId라도 서로 다른 PA와 ordinal의 실제 투구에 각각 연결한다", () => {
    const document = withCandidates([
      candidate("t1", 0, "e2", 1, { kind: "linked", pitchEventId: "e2" }),
      {
        ...candidate("t2", 1, "e6", 1, { kind: "linked", pitchEventId: "e6" }),
        plateAppearanceEventId: "e5",
        batterId: "a2",
      },
    ]);
    const replay = compileStagingGameDocumentV2(document);

    expect(
      replay.findings.filter(
        (finding) => finding.code.includes("tracking") && finding.severity === "blocking",
      ),
    ).toEqual([]);
    expect(document.trackingCandidates.map((item) => item.sourcePitchId)).toEqual([
      "naver-reused-id",
      "naver-reused-id",
    ]);
    expect(
      replay.findings.filter((finding) => finding.code === "source.pitch_id.reused_within_game"),
    ).toHaveLength(2);
    expect(
      replay.findings
        .filter((finding) => finding.code === "source.pitch_id.reused_within_game")
        .every((finding) => finding.severity === "warning"),
    ).toBe(true);
  });

  it("공급자 PTS 순번은 실제 투구 순번과 달라도 link를 차단하지 않는다", () => {
    const providerOrdinalDrift = withCandidates([
      candidate("t1", 0, "e2", 2, { kind: "linked", pitchEventId: "e2" }),
    ]);
    expect(codes(providerOrdinalDrift)).not.toContain("domain.tracking.pitch_ordinal_mismatch");
    expect(codes(providerOrdinalDrift)).toContain(
      "source.tracking.ordinal_differs_from_actual_pitch",
    );
    expect(
      compileStagingGameDocumentV2(providerOrdinalDrift).findings.filter(
        (finding) => finding.code.includes("tracking") && finding.severity === "blocking",
      ),
    ).toEqual([]);
  });

  it("pending과 한 투구의 다중 canonical을 각각 차단한다", () => {
    const pending = withCandidates([candidate("t1", 0, "e2", 1, { kind: "pending" })]);
    expect(codes(pending)).toContain("source.tracking.pending");

    const multiple = withCandidates([
      candidate("t1", 0, "e2", 1, { kind: "linked", pitchEventId: "e2" }),
      {
        ...candidate("t2", 1, "e2", 1, { kind: "linked", pitchEventId: "e2" }),
        crossPlateX: 0.2,
      },
    ]);
    expect(
      codes(multiple).filter((code) => code === "domain.tracking.multiple_canonical"),
    ).toHaveLength(2);
  });

  it("타석 중 대타 머리글 뒤 투구도 compiler가 계산한 기존 PA 순번으로 검증한다", () => {
    const base = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
        {
          kind: "pitch",
          payload: { sourcePitchId: "first-pitch", call: "called_strike" },
        },
        {
          kind: "substitution",
          payload: {
            side: "away",
            role: "batter",
            incomingPlayerId: "a2",
            outgoingPlayerId: "a1",
          },
        },
        { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
        {
          kind: "pitch",
          payload: { sourcePitchId: "naver-reused-id", call: "in_play" },
        },
        {
          kind: "plate_result",
          payload: { result: "field_out", batterId: "a2", pitcherId: "hp1", outsRecorded: 1 },
        },
      ]),
    );
    const document = parseStagingGameDocumentV2({
      ...base,
      trackingCandidates: [
        {
          ...candidate("t-substitute", 0, "e5", 1, {
            kind: "linked",
            pitchEventId: "e5",
          }),
          plateAppearanceEventId: "e1",
          batterId: "a2",
        },
      ],
    });

    const replay = compileStagingGameDocumentV2(document);

    expect(replay.pitchFacts.find((pitch) => pitch.pitchId === "e5")).toMatchObject({
      plateAppearanceEventId: "e1",
      actualPitchNumber: 2,
      batterId: "a2",
    });
    expect(
      replay.findings.filter(
        (finding) => finding.code.includes("tracking") && finding.severity === "blocking",
      ),
    ).toEqual([]);
  });

  it("tracking이 있는 경기의 실제 투구 누락만 warning으로 보고 비실제 투구는 제외한다", () => {
    const document = withCandidates([
      candidate("t1", 0, "e2", 1, { kind: "linked", pitchEventId: "e2" }),
    ]);
    const missing = compileStagingGameDocumentV2(document).findings.filter(
      (finding) => finding.code === "source.tracking.missing_for_pitch",
    );

    expect(missing.every((finding) => finding.severity === "warning")).toBe(true);
    expect(missing.map((finding) => finding.eventId)).toEqual(["e3", "e6"]);
  });

  it("중복 그룹 batch 교정 후 실제 투구당 canonical tracking 0..1을 만족한다", () => {
    const document = withCandidates([
      candidate("t1", 0, "e2", 1, { kind: "pending" }),
      candidate("t2", 1, "e2", 1, { kind: "pending" }),
    ]);
    const corrected = applyCorrectionCommand(document, {
      commandId: "batch",
      kind: "correction_batch",
      commands: [
        {
          commandId: "link",
          kind: "link_tracking_candidate",
          trackingId: "t1",
          pitchEventId: "e2",
        },
        {
          commandId: "duplicate",
          kind: "mark_tracking_duplicate",
          trackingId: "t2",
          canonicalTrackingId: "t1",
        },
      ],
    });

    expect(corrected.replay.findings.filter((finding) => finding.severity === "blocking")).toEqual(
      [],
    );
    expect(
      corrected.document.trackingCandidates.filter(
        (item) => item.resolution.kind === "linked" && item.resolution.pitchEventId === "e2",
      ),
    ).toHaveLength(1);
    expect(corrected.preview.trackingResolutionChanges).toBe(2);
  });
});

function withCandidates(candidates: readonly TrackingCandidate[]): StagingGameDocumentV2 {
  const base = parseStagingGameDocumentV2(
    makeDocument([
      { kind: "half_inning_start", payload: {} },
      { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
      { kind: "pitch", payload: { sourcePitchId: "naver-reused-id", call: "ball" } },
      { kind: "pitch", payload: { sourcePitchId: "other-id", call: "in_play" } },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId: "a1", pitcherId: "hp1", outsRecorded: 1 },
      },
      { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
      {
        kind: "pitch",
        payload: { sourcePitchId: "naver-reused-id", call: "in_play" },
      },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId: "a2", pitcherId: "hp1", outsRecorded: 1 },
      },
    ]),
  );
  return parseStagingGameDocumentV2({ ...base, trackingCandidates: candidates });
}

function candidate(
  trackingId: string,
  sequence: number,
  pitchEventId: string,
  sourcePitchOrdinal: number,
  resolution: TrackingCandidate["resolution"],
): TrackingCandidate {
  return {
    trackingId,
    source: { endpoint: "tracking", blockIndex: 0, rowIndex: sequence },
    sourcePitchId: "naver-reused-id",
    sourcePitchOrdinal,
    sequence,
    inning: 1,
    half: "top",
    plateAppearanceEventId: pitchEventId === "e6" ? "e5" : "e1",
    pitcherId: "hp1",
    batterId: pitchEventId === "e6" ? "a2" : "a1",
    crossPlateX: 0.1,
    crossPlateY: 2.5,
    topSz: 3.5,
    bottomSz: 1.5,
    resolution,
  };
}

function codes(document: StagingGameDocumentV2): string[] {
  return compileStagingGameDocumentV2(document).findings.map((finding) => finding.code);
}
