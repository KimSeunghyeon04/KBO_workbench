// @vitest-environment jsdom

import {
  parseStagingGameDocumentV2,
  type CorrectionEventContext,
  type CorrectionFinding,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CorrectionCommitControls,
  EventDetail,
  FindingPanel,
  OriginalComparisonView,
  RecordDetail,
} from "../../apps/web/src/correction/correction-workbench-panels.js";
import type { EventPresentation } from "../../apps/web/src/correction/event-presentation.js";
import type { OriginalComparison } from "../../apps/web/src/correction/original-comparison.js";

afterEach(() => cleanup());

describe("Correction 작업대 표시", () => {
  it("차단 finding은 quarantine 저장을 명시적으로 확인한 뒤에만 제출한다", async () => {
    const onCommit = vi.fn();
    const view = render(
      createElement(CorrectionCommitControls, {
        dirty: true,
        promotionAvailable: false,
        blockingCount: 1,
        busy: false,
        allowQuarantine: false,
        onAllowQuarantine: (allowed: boolean) => {
          view.rerender(
            createElement(CorrectionCommitControls, {
              dirty: true,
              promotionAvailable: false,
              blockingCount: 1,
              busy: false,
              allowQuarantine: allowed,
              onAllowQuarantine: () => undefined,
              onCommit,
            }),
          );
        },
        onCommit,
      }),
    );
    const save = screen.getByRole("button", { name: "격리 원장 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent
      .setup()
      .click(screen.getByLabelText("차단 finding을 확인했으며 quarantine 저장을 허용합니다."));
    expect(save.disabled).toBe(false);
    await userEvent.setup().click(save);
    expect(onCommit).toHaveBeenCalledWith(true);

    view.rerender(
      createElement(CorrectionCommitControls, {
        dirty: true,
        promotionAvailable: false,
        blockingCount: 0,
        busy: false,
        allowQuarantine: false,
        onAllowQuarantine: () => undefined,
        onCommit,
      }),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "현재 원장 저장" }));
    expect(onCommit).toHaveBeenLastCalledWith(false);
  });

  it("차단이 사라진 clean quarantine만 변경 없이 staging 승격할 수 있다", async () => {
    const onCommit = vi.fn();
    const view = render(
      createElement(CorrectionCommitControls, {
        dirty: false,
        promotionAvailable: true,
        blockingCount: 0,
        busy: false,
        allowQuarantine: false,
        onAllowQuarantine: () => undefined,
        onCommit,
      }),
    );

    const promote = screen.getByRole("button", { name: "staging으로 승격" });
    expect((promote as HTMLButtonElement).disabled).toBe(false);
    await userEvent.setup().click(promote);
    expect(onCommit).toHaveBeenCalledWith(false);

    view.rerender(
      createElement(CorrectionCommitControls, {
        dirty: false,
        promotionAvailable: false,
        blockingCount: 0,
        busy: false,
        allowQuarantine: false,
        onAllowQuarantine: () => undefined,
        onCommit,
      }),
    );
    expect(
      (screen.getByRole("button", { name: "현재 원장 저장" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("finding을 검색·심각도·범주·저장 당시 상태로 필터하고 행을 선택한다", async () => {
    const current = finding("runner_destination_occupied", "e1", 2, "domain", "blocking");
    current.details.push({ field: "homeScore", expected: 1, actual: 2 });
    const warning = finding("source_observation_mismatch", "e2", 3, "source", "warning");
    const stored = finding("resolved_source_row", "e3", 4, "source", "blocking");
    const onSelect = vi.fn();
    render(
      createElement(FindingPanel, {
        session: {
          findings: [current, warning],
          storedFindings: [current, stored],
          draftDocument: fixture(),
          eventContexts: [],
        },
        selectedEventId: null,
        selectedRecordIdentity: null,
        selectedTrackingId: null,
        onSelectEvent: onSelect,
        onSelectRecord: vi.fn(),
        onSelectTracking: vi.fn(),
      }),
    );

    expect(screen.getByText("2 / 2건")).toBeTruthy();
    expect(screen.getByText("홈 점수: 예상 1 → 계산 2")).toBeTruthy();
    await userEvent.setup().selectOptions(screen.getByLabelText("finding 범주"), "domain");
    expect(screen.getByText("1 / 2건")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /runner_destination/ }));
    expect(onSelect).toHaveBeenCalledWith("e1");

    await userEvent.setup().selectOptions(screen.getByLabelText("finding 범주"), "all");
    await userEvent.setup().type(screen.getByLabelText("finding 검색"), "observation");
    expect(screen.getByRole("button", { name: /source_observation/ })).toBeTruthy();
    await userEvent.setup().clear(screen.getByLabelText("finding 검색"));
    await userEvent.setup().selectOptions(screen.getByLabelText("finding 시점"), "stored");
    expect(screen.getByText("2 / 3건")).toBeTruthy();
    expect(screen.getByText("resolved_source_row")).toBeTruthy();
  });

  it("공식 기록 finding에 선수·팀을 표시하고 해당 기록 비교로 연다", async () => {
    const document = recordFixture();
    const onSelectRecord = vi.fn();
    const batterMismatch = recordFinding(
      "official_batter_record_mismatch",
      "batter:anon-batter",
      "runsBattedIn",
      1,
      0,
    );
    const pitcherMismatch = recordFinding(
      "official_pitcher_record_mismatch",
      "pitcher:anon-pitcher",
      "pitches",
      4,
      3,
    );
    render(
      createElement(FindingPanel, {
        session: {
          findings: [batterMismatch, pitcherMismatch],
          storedFindings: [],
          draftDocument: document,
          eventContexts: [],
        },
        selectedEventId: null,
        selectedRecordIdentity: null,
        selectedTrackingId: null,
        onSelectEvent: vi.fn(),
        onSelectRecord,
        onSelectTracking: vi.fn(),
      }),
    );

    expect(screen.getByText("타자 · 원정 비식별팀 비식별 타자 (anon-batter)")).toBeTruthy();
    expect(screen.getByText("투수 · 홈 비식별팀 비식별 투수 (anon-pitcher)")).toBeTruthy();
    expect(screen.getByText("타점: 예상 1 → 계산 0")).toBeTruthy();
    expect(screen.getByText("투구 수: 예상 4 → 계산 3")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /공식 타자 기록/ }));
    expect(onSelectRecord).toHaveBeenCalledWith("batter:anon-batter");

    await userEvent.setup().type(screen.getByLabelText("finding 검색"), "비식별 투수");
    expect(screen.getByText("1 / 2건")).toBeTruthy();
    expect(screen.getByRole("button", { name: /공식 투수 기록/ })).toBeTruthy();
  });

  it("같은 sourcePitchId 경고에 모든 원천 위치를 표시하고 해당 원장 행을 연다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(
        readFileSync("tests/fixtures/tracking-duplicate-review.anonymized.json", "utf8"),
      ) as unknown,
    );
    const replay = compileStagingGameDocumentV2(document);
    const trackingFinding = replay.findings.find(
      (item) => item.code === "source.pitch_id.reused_within_game" && item.eventId === "anon-pitch",
    );
    if (trackingFinding === undefined) throw new Error("tracking finding fixture missing");
    const onSelectEvent = vi.fn();
    const eventContexts: CorrectionEventContext[] = [
      {
        eventId: "anon-pitch",
        applied: true,
        before: state(0, [null, null, null]),
        after: state(0, [null, null, null]),
        pitch: {
          plateAppearanceEventId: "anon-pa",
          pitchEventNumber: 1,
          actualPitchNumber: 1,
          batterId: "anon-batter",
          pitcherId: "anon-pitcher",
          sourcePitchId: "anon-source-pitch",
          call: "called_strike",
          actual: true,
        },
      },
    ];

    render(
      createElement(FindingPanel, {
        session: {
          findings: [trackingFinding],
          storedFindings: [],
          draftDocument: document,
          eventContexts,
        },
        selectedEventId: null,
        selectedRecordIdentity: null,
        selectedTrackingId: null,
        onSelectEvent,
        onSelectRecord: vi.fn(),
        onSelectTracking: vi.fn(),
      }),
    );

    expect(screen.getByText("3행")).toBeTruthy();
    expect(screen.getByText(/relay_005:6:1/)).toBeTruthy();
    expect(screen.getByText(/relay_005:7:1/)).toBeTruthy();
    expect(screen.queryByText(/대표 후보/)).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: /같은 sourcePitchId/ }));
    expect(onSelectEvent).toHaveBeenCalledWith("anon-pitch");
  });

  it("타자·투수의 공식 기록과 compiler 계산 기록을 선수별로 비교한다", async () => {
    const document = recordFixture();
    const replay = compileStagingGameDocumentV2(document);
    const calculatedRecords = {
      batters: replay.batterLines.map((record) => ({ ...record })),
      pitchers: replay.pitcherLines.map((record) => ({ ...record })),
    };
    const onKindChange = vi.fn();
    const onSelectRecord = vi.fn();
    const view = render(
      createElement(RecordDetail, {
        document,
        calculatedRecords,
        kind: "batter",
        selectedRecordIdentity: "batter:anon-batter",
        onKindChange,
        onSelectRecord,
        onClose: vi.fn(),
      }),
    );

    expect(screen.getByText("비식별 타자")).toBeTruthy();
    expect(screen.getByRole("row", { name: /타점.*1.*0.*불일치/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /삼진.*1.*1.*일치/ })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "투수 1명" }));
    expect(onKindChange).toHaveBeenCalledWith("pitcher");

    view.rerender(
      createElement(RecordDetail, {
        document,
        calculatedRecords,
        kind: "pitcher",
        selectedRecordIdentity: "pitcher:anon-pitcher",
        onKindChange,
        onSelectRecord,
        onClose: vi.fn(),
      }),
    );
    expect(screen.getByText("비식별 투수")).toBeTruthy();
    expect(screen.getByRole("button", { name: "투수 1명" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("row", { name: /투구 수.*4.*3.*불일치/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /자책점.*0.*계산 제외.*검증 제외/ })).toBeTruthy();
  });

  it("행 상세에서 구조 요약과 compiler 전후 상태를 먼저 표시하고 payload를 접는다", () => {
    const document = fixture();
    const event = document.events[0];
    if (event === undefined) throw new Error("event fixture missing");
    const presentation: EventPresentation = {
      event,
      kindLabel: "이닝 시작",
      location: "1회초",
      title: "1회초 원정팀 공격",
      summary: "원정팀 공격",
      stateText: "B0 S0 O0 · 주자 없음 · 0:0",
      searchText: "원정팀",
      startsHalf: true,
    };
    const context: CorrectionEventContext = {
      eventId: event.identity.eventId,
      applied: true,
      before: state(0, [null, null, null]),
      after: state(1, ["away-1", null, null]),
    };
    render(
      createElement(EventDetail, {
        presentation,
        context,
        findings: [
          {
            ...finding(
              "source_observation_mismatch",
              event.identity.eventId,
              0,
              "source",
              "blocking",
            ),
            details: [{ field: "homeScore", expected: 1, actual: 2 }],
          },
        ],
        document,
      }),
    );

    expect(screen.getByText("원정팀 공격")).toBeTruthy();
    expect(screen.getByText(/B0 S0 O0/)).toBeTruthy();
    expect(screen.getByText(/B1 S0 O0 · 1루 원정 타자/)).toBeTruthy();
    expect(screen.getByText("홈 점수: 예상 1 → 계산 2")).toBeTruthy();
    const technical = screen.getByText("원천 증거와 정규화 값").closest("details");
    expect(technical?.open).toBe(false);
    expect(technical?.textContent).toContain("event ID");
  });

  it("삭제된 tracking PA 문맥만 재계산하고 compiler와 tracking 값을 구분해 표시한다", async () => {
    const original = parseStagingGameDocumentV2(
      JSON.parse(
        readFileSync("tests/fixtures/correction-tracking-pa-rebase.anonymized.json", "utf8"),
      ) as unknown,
    );
    const document = parseStagingGameDocumentV2({
      ...original,
      events: original.events
        .filter(
          (event) =>
            event.identity.eventId !== "anon-pa-old" && event.identity.eventId !== "anon-pitch-old",
        )
        .map((event, sequence) => ({ ...event, sequence })),
    });
    const replay = compileStagingGameDocumentV2(document);
    const event = document.events.find(
      (candidate) => candidate.identity.eventId === "anon-pitch-current",
    );
    const pitch = replay.pitchFacts.find((candidate) => candidate.pitchId === "anon-pitch-current");
    const mismatch = replay.findings.find(
      (finding) => finding.code === "domain.tracking.plate_appearance_mismatch",
    );
    if (
      event === undefined ||
      event.kind !== "pitch" ||
      pitch === undefined ||
      mismatch === undefined
    )
      throw new Error("PA mismatch fixture missing");
    const eventContext: CorrectionEventContext = {
      eventId: event.identity.eventId,
      applied: true,
      before: state(0, [null, null, null]),
      after: state(0, [null, null, null]),
      pitch: {
        plateAppearanceEventId: pitch.plateAppearanceEventId,
        pitchEventNumber: pitch.pitchEventNumber,
        actualPitchNumber: pitch.actualPitchNumber,
        batterId: pitch.batterId,
        pitcherId: pitch.pitcherId,
        sourcePitchId: pitch.sourcePitchId,
        call: pitch.call,
        actual: pitch.actual,
      },
    };
    const onApply = vi.fn();
    const view = render(
      createElement(EventDetail, {
        presentation: pitchPresentation(event),
        context: eventContext,
        findings: [mismatch],
        document,
        eventContexts: [eventContext],
        exceptionTrackingId: null,
        pending: false,
        onApply,
      }),
    );

    expect(
      screen.getByText("compiler PA: anon-pa-current · tracking PA: anon-pa-old"),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "삭제된 PA 문맥 재계산" }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "reconcile_tracking_plate_appearance_contexts" }),
    );

    view.unmount();
    const genuineMismatch = parseStagingGameDocumentV2({
      ...original,
      trackingCandidates: original.trackingCandidates.map((candidate) => ({
        ...candidate,
        plateAppearanceEventId: "anon-pa-current",
      })),
    });
    const genuineReplay = compileStagingGameDocumentV2(genuineMismatch);
    const genuineFinding = genuineReplay.findings.find(
      (finding) => finding.code === "domain.tracking.plate_appearance_mismatch",
    );
    const genuinePitch = genuineReplay.pitchFacts.find(
      (candidate) => candidate.pitchId === "anon-pitch-current",
    );
    if (genuineFinding === undefined || genuinePitch === undefined)
      throw new Error("genuine PA mismatch fixture missing");
    const genuineContext: CorrectionEventContext = {
      ...eventContext,
      pitch: { ...eventContext.pitch, plateAppearanceEventId: genuinePitch.plateAppearanceEventId },
    };
    render(
      createElement(EventDetail, {
        presentation: pitchPresentation(event),
        context: genuineContext,
        findings: [genuineFinding],
        document: genuineMismatch,
        eventContexts: [genuineContext],
        exceptionTrackingId: null,
        pending: false,
        onApply,
      }),
    );
    expect(screen.queryByRole("button", { name: "삭제된 PA 문맥 재계산" })).toBeNull();
  });

  it("최초 원장 비교에 이벤트 전후와 비이벤트 변경 수를 함께 표시한다", () => {
    const comparison: OriginalComparison = {
      events: [
        {
          eventId: "anonymous-event-1",
          kind: "changed",
          originalSequence: 0,
          currentSequence: 0,
          originalText: "원래 중계",
          currentText: "수정 중계",
          originalSummary: "1회초 · 투구",
          currentSummary: "1회초 · 투구",
        },
      ],
      eventCounts: { added: 0, removed: 0, changed: 1, moved: 0 },
      rosterChanges: 1,
      trackingChanges: 2,
      officialRecordChanges: 3,
    };
    render(createElement(OriginalComparisonView, { comparison }));

    expect(screen.getByText("수정 1")).toBeTruthy();
    expect(screen.getByText("명단 1")).toBeTruthy();
    expect(screen.getByText("tracking 2")).toBeTruthy();
    expect(screen.getByText("공식 기록 3")).toBeTruthy();
    expect(screen.getByText("원래 중계")).toBeTruthy();
    expect(screen.getByText("수정 중계")).toBeTruthy();
  });
});

function finding(
  code: string,
  eventId: string,
  eventSequence: number,
  category: CorrectionFinding["category"],
  severity: CorrectionFinding["severity"],
): CorrectionFinding {
  return {
    code,
    category,
    severity,
    message: `${code} 비식별 메시지`,
    gameId: "anonymous-game",
    eventId,
    eventSequence,
    details: [],
  };
}

function fixture() {
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "anonymous-game",
      collectedAt: "2026-08-20T03:00:00.000Z",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "anonymous-game",
      season: 2026,
      gameDate: "2026-08-20",
      status: "scheduled",
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정팀" },
      home: { teamId: "HOME", name: "홈팀" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: [
          {
            playerId: "away-1",
            name: "원정 타자",
            starter: true,
            positions: ["1B"],
          },
        ],
      },
      home: { teamId: "HOME", players: [] },
    },
    events: [
      {
        identity: {
          kind: "source",
          eventId: "anonymous-event-1",
          endpoint: "relay-test",
          blockIndex: 0,
          eventIndex: 0,
        },
        sequence: 0,
        inning: 1,
        half: "top",
        relayText: "1회초 원정팀 공격",
        kind: "half_inning_start",
        payload: {},
      },
    ],
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  });
}

function recordFixture() {
  return parseStagingGameDocumentV2(
    JSON.parse(
      readFileSync("tests/fixtures/correction-record-mismatch.anonymized.json", "utf8"),
    ) as unknown,
  );
}

function pitchPresentation(
  event: Extract<ReturnType<typeof fixture>["events"][number], { kind: "pitch" }>,
): EventPresentation {
  return {
    event,
    kindLabel: "투구",
    location: "4회말",
    title: event.relayText ?? "비식별 투구",
    summary: "타격",
    stateText: "B0 S0 O0 · 주자 없음 · 0:0",
    searchText: event.relayText ?? "",
    startsHalf: false,
  };
}

function recordFinding(
  code: string,
  recordIdentity: string,
  field: string,
  expected: number,
  actual: number,
): CorrectionFinding {
  return {
    code,
    category: "domain",
    severity: "blocking",
    message: recordIdentity.startsWith("batter:")
      ? "공식 타자 기록과 compiler 계산 기록이 다릅니다."
      : "공식 투수 기록과 compiler 계산 기록이 다릅니다.",
    gameId: "anonymous-record-game",
    recordIdentity,
    details: [{ field, expected, actual }],
  };
}

function state(balls: number, bases: [string | null, string | null, string | null]) {
  return {
    balls,
    strikes: 0,
    outs: 0,
    bases,
    awayScore: 0,
    homeScore: 0,
    batterId: null,
    pitcherId: null,
  };
}
