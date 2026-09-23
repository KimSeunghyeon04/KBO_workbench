import { readFile } from "node:fs/promises";

import {
  parseRecordCorrectionSeasonDataset,
  parseStagingGameDocumentV2,
  type OfficialBatterRecord,
  type OfficialPitcherRecord,
  type RecordCorrectionNotice,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import {
  buildRecordCorrectionBatchProposal,
  createRecordCorrectionProposalBuilder,
} from "@kbo/correction";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import { describe, expect, it } from "vitest";
import {
  derivedAfterScenarios,
  recordCorrectionDerivedAfterFixture,
} from "../helpers/record-correction-fixture.js";

describe("KBO 기록정정 correction batch", () => {
  it.each(derivedAfterScenarios)(
    "does not mark unsupported derived after-state as complete or guess missing RBI: %s",
    async (scenario) => {
      const { document, notice, binding } = await recordCorrectionDerivedAfterFixture(scenario);
      const original = structuredClone(document);
      const replay = compileStagingGameDocumentV2(document);
      expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([]);
      const proposal = buildRecordCorrectionBatchProposal(document, notice, binding);
      expect(proposal.eligible).toBe(false);
      expect(proposal.reasons).toContainEqual(
        expect.stringContaining(
          scenario.startsWith("rbi")
            ? "anon-batter의 타점 compiler 계산값(0)"
            : "anon-batter의 2루타 compiler 계산값(1)",
        ),
      );
      if (scenario === "rbi_official_before") {
        expect(proposal.batch?.commands.map((command) => command.kind)).toEqual([
          "update_official_record",
        ]);
        expect(proposal.preview?.afterBlockingCount).toBe(0);
      } else expect(proposal.batch).toBeNull();
      if (scenario === "omitted_double_with_total_bases")
        expect(proposal.reasons).toContainEqual(expect.stringContaining("루타 파생값"));
      expect(document).toEqual(original);
    },
  );

  it("recognizes an already-applied RBI only when the compiler also confirms it", async () => {
    const source = await recordCorrectionDerivedAfterFixture("rbi_official_after");
    const document = parseStagingGameDocumentV2({
      ...source.document,
      events: source.document.events.map((event) =>
        event.kind === "plate_result"
          ? { ...event, payload: { ...event.payload, creditedRbi: 1 } }
          : event,
      ),
    });
    expect(
      buildRecordCorrectionBatchProposal(document, source.notice, source.binding),
    ).toMatchObject({
      eligible: false,
      reasons: [],
      batch: null,
    });
  });

  it("keeps ER and unsupported fielding counts as source evidence outside compiler verification", async () => {
    const source = await recordCorrectionDerivedAfterFixture("rbi_official_after");
    const pitcher = compileStagingGameDocumentV2(source.document).pitcherLines[0];
    if (pitcher === undefined) throw new Error("비식별 투수 기록이 없습니다.");
    const document = parseStagingGameDocumentV2({
      ...source.document,
      officialRecords: {
        ...source.document.officialRecords,
        pitchers: [{ ...pitcher, earnedRuns: 1 }],
      },
    });
    const notice: RecordCorrectionNotice = {
      ...source.notice,
      statChanges: [
        {
          statIndex: 0,
          participantIndex: 1,
          rawStatName: "자책점",
          statCode: "earned_runs",
          scope: "pitcher",
          beforeValue: 0,
          afterValue: 1,
          supportKind: "direct",
        },
        {
          statIndex: 1,
          participantIndex: 1,
          rawStatName: "실책",
          statCode: "fielding_errors",
          scope: "fielder",
          beforeValue: 1,
          afterValue: 0,
          supportKind: "evidence_only",
        },
      ],
    };
    expect(buildRecordCorrectionBatchProposal(document, notice, source.binding)).toMatchObject({
      eligible: false,
      reasons: [],
      batch: null,
    });
    document.officialRecords.pitchers[0] = { ...pitcher, earnedRuns: 0 };
    const proposal = buildRecordCorrectionBatchProposal(document, notice, source.binding);
    expect(proposal.eligible).toBe(true);
    expect(proposal.reasons).toEqual([]);
    expect(proposal.batch?.commands).toEqual([
      expect.objectContaining({
        kind: "update_official_record",
        recordType: "pitcher",
        record: expect.objectContaining({ earnedRuns: 1 }),
      }),
    ]);
  });

  it("플레이 identity와 Naver 원문을 보존한 원자적 제안을 만든다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const notice: RecordCorrectionNotice = {
      noticeId: "2024:0:999",
      noticeHash: "a".repeat(64),
      sourceRequestKey: "records:2024:0:1",
      sourceRowIndex: 0,
      seriesId: 0,
      seriesName: "정규시즌",
      recordNumber: 999,
      gameDate: document.metadata.gameDate,
      weekdayText: "",
      awayTeamName: document.teams.away.name,
      homeTeamName: document.teams.home.name,
      doubleheaderNumber: null,
      venueName: document.metadata.stadium ?? "비식별구장",
      inning: 1,
      half: "top",
      battingOrder: 2,
      decisionBefore: "hit",
      decisionAfter: "error",
      beforeRecordText: "안타",
      afterRecordText: "실책",
      contentText: "비식별 fixture",
      correctionDateText: "01.01",
      participants: [
        {
          participantIndex: 0,
          rawTeamName: null,
          rawPlayerName: "원정2",
          role: "batter",
          parenthesized: false,
        },
        {
          participantIndex: 1,
          rawTeamName: null,
          rawPlayerName: "홈투수",
          role: "pitcher",
          parenthesized: true,
        },
      ],
      statChanges: [],
    };
    const proposal = buildRecordCorrectionBatchProposal(document, notice, {
      eventId: "e10",
      batterPlayerId: "a2",
      pitcherPlayerId: "hp1",
      participantPlayerIds: { "0": "a2", "1": "hp1" },
    });
    expect(proposal.eligible).toBe(true);
    const build = createRecordCorrectionProposalBuilder(document);
    const binding = {
      eventId: "e10",
      batterPlayerId: "a2",
      pitcherPlayerId: "hp1",
      participantPlayerIds: { "0": "a2", "1": "hp1" },
    };
    const reusable = build(notice, binding);
    expect(reusable).toEqual(proposal);
    document.teams.away.name = "caller changed";
    if (reusable.batch !== null) reusable.batch.commands.splice(0);
    expect(build(notice, binding)).toEqual(proposal);
    const replacement = proposal.batch?.commands.find(
      (command) => command.kind === "replace_event",
    );
    expect(replacement).toMatchObject({
      eventId: "e10",
      event: {
        identity: { eventId: "e10", endpoint: "relay", blockIndex: 0, eventIndex: 10 },
        relayText: "원정2 : 좌전 안타",
        payload: { result: "reached_on_error" },
      },
    });
    expect(proposal.preview?.afterBlockingCount).toBe(proposal.preview?.beforeBlockingCount);
  });

  it("공식 기록 행의 생략 가능한 비발생 계수는 일관되게 0으로 비교한다", async () => {
    const sourceDocument = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const document = withOmittedZeroCountRecords(sourceDocument);
    const notice = await omittedZeroCountNotice();

    const proposal = buildRecordCorrectionBatchProposal(document, notice, {
      eventId: "e10",
      batterPlayerId: "a2",
      pitcherPlayerId: "hp1",
      participantPlayerIds: { "0": "a2", "1": "hp1" },
    });

    expect(proposal.eligible).toBe(true);
    expect(proposal.reasons).toEqual([]);
    expect(
      proposal.changes
        .filter(
          (change) =>
            change.kind === "official_batter" &&
            [
              "doubles",
              "triples",
              "intentionalWalks",
              "hitByPitch",
              "sacrificeBunts",
              "sacrificeFlies",
            ].includes(change.field),
        )
        .map((change) => ({
          field: change.field,
          beforeValue: change.beforeValue,
          afterValue: change.afterValue,
          state: change.state,
        })),
    ).toEqual([
      { field: "doubles", beforeValue: 0, afterValue: 0, state: "already_applied" },
      { field: "triples", beforeValue: 0, afterValue: 0, state: "already_applied" },
      { field: "intentionalWalks", beforeValue: 0, afterValue: 0, state: "already_applied" },
      { field: "hitByPitch", beforeValue: 0, afterValue: 0, state: "already_applied" },
      { field: "sacrificeBunts", beforeValue: 0, afterValue: 0, state: "already_applied" },
      { field: "sacrificeFlies", beforeValue: 0, afterValue: 0, state: "already_applied" },
    ]);
    expect(
      proposal.changes.find(
        (change) => change.kind === "official_pitcher" && change.field === "intentionalWalks",
      ),
    ).toMatchObject({ beforeValue: 0, afterValue: 0, state: "already_applied" });
    expect(proposal.batch?.commands).toEqual([
      expect.objectContaining({
        kind: "update_official_record",
        recordType: "batter",
        playerId: "a2",
        record: expect.objectContaining({ hits: 1 }),
      }),
    ]);
  });

  it("수집 범위에 따라 생략될 수 있는 계수는 0으로 추정하지 않는다", async () => {
    const sourceDocument = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const document = withOmittedZeroCountRecords(sourceDocument);
    const sourceNotice = await omittedZeroCountNotice();
    const notice: RecordCorrectionNotice = {
      ...sourceNotice,
      statChanges: [
        {
          statIndex: 0,
          participantIndex: 1,
          rawStatName: "투구 수",
          statCode: "pitches",
          scope: "pitcher",
          beforeValue: 1,
          afterValue: 0,
          supportKind: "direct",
        },
      ],
    };

    const proposal = buildRecordCorrectionBatchProposal(document, notice, {
      eventId: "e10",
      batterPlayerId: "a2",
      pitcherPlayerId: "hp1",
      participantPlayerIds: { "0": "a2", "1": "hp1" },
    });

    expect(proposal.eligible).toBe(false);
    expect(proposal.changes).toContainEqual(
      expect.objectContaining({
        kind: "official_pitcher",
        field: "pitches",
        beforeValue: null,
        afterValue: 0,
        state: "conflict",
      }),
    );
  });

  it("투수 범위의 타자용 통계가 과거에 적용 지원으로 저장돼도 충돌시키지 않는다", async () => {
    const document = parseStagingGameDocumentV2(
      JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
    );
    const notice: RecordCorrectionNotice = {
      ...(await omittedZeroCountNotice()),
      decisionBefore: "hit",
      decisionAfter: "error",
      statChanges: [
        {
          statIndex: 0,
          participantIndex: 1,
          rawStatName: "희비",
          statCode: "sacrifice_flies",
          scope: "pitcher",
          beforeValue: 1,
          afterValue: 0,
          supportKind: "direct",
        },
      ],
    };

    const proposal = buildRecordCorrectionBatchProposal(document, notice, {
      eventId: "e10",
      batterPlayerId: "a2",
      pitcherPlayerId: "hp1",
      participantPlayerIds: { "0": "a2", "1": "hp1" },
    });

    expect(proposal.eligible).toBe(true);
    expect(proposal.reasons).toEqual([]);
    expect(proposal.changes).toContainEqual(
      expect.objectContaining({
        kind: "evidence_only",
        field: "희비",
        state: "evidence_only",
      }),
    );
    expect(
      proposal.changes.some(
        (change) => change.kind === "official_pitcher" && change.state === "conflict",
      ),
    ).toBe(false);
  });
});

async function omittedZeroCountNotice(): Promise<RecordCorrectionNotice> {
  const rawNotice = JSON.parse(
    await readFile(
      "tests/fixtures/correction/record-correction-omitted-zero-counts.anonymized.json",
      "utf8",
    ),
  ) as unknown;
  const dataset = parseRecordCorrectionSeasonDataset({
    season: 2024,
    collectedAt: "2026-09-02T00:00:00.000Z",
    sourcePages: [
      {
        pageKind: "records",
        requestKey: "records:2024:0:1",
        seriesId: 0,
        pageNumber: 1,
        artifactKey: "anonymous/records.json.gz",
        contentHash: "b".repeat(64),
        collectedAt: "2026-09-02T00:00:00.000Z",
        rowCount: 1,
        totalCount: 1,
      },
    ],
    notices: [rawNotice],
  });
  const notice = dataset.notices[0];
  if (notice === undefined) throw new Error("비식별 기록정정 공지가 없습니다.");
  return notice;
}

function withOmittedZeroCountRecords(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  const replay = compileStagingGameDocumentV2(document);
  const batter = replay.batterLines.find((line) => line.playerId === "a2");
  const pitcher = replay.pitcherLines.find((line) => line.playerId === "hp1");
  if (batter === undefined || pitcher === undefined)
    throw new Error("비식별 회귀 원장의 선수 계산 기록이 없습니다.");
  const officialBatter: OfficialBatterRecord = {
    playerId: batter.playerId,
    side: batter.side,
    plateAppearances: batter.plateAppearances,
    atBats: batter.atBats,
    runs: batter.runs,
    hits: 0,
    homeRuns: batter.homeRuns,
    runsBattedIn: batter.runsBattedIn,
    walks: batter.walks,
    strikeouts: batter.strikeouts,
  };
  const officialPitcher: OfficialPitcherRecord = {
    playerId: pitcher.playerId,
    side: pitcher.side,
    battersFaced: pitcher.battersFaced,
    outsRecorded: pitcher.outsRecorded,
    hits: pitcher.hits,
    runs: pitcher.runs,
    earnedRuns: 0,
    walks: pitcher.walks,
    hitByPitch: pitcher.hitByPitch,
    strikeouts: pitcher.strikeouts,
  };
  return {
    ...document,
    officialRecords: { batters: [officialBatter], pitchers: [officialPitcher] },
  };
}
