import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseStagingGameDocumentV2,
  type OfficialBatterRecord,
  type OfficialPitcherRecord,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, stagingDocumentHash } from "@kbo/game-core";

import { makeDocument } from "../helpers/game-document.js";

const zeroBatter: OfficialBatterRecord = {
  playerId: "a1",
  side: "away",
  atBats: 0,
  runs: 0,
  hits: 0,
  homeRuns: 0,
  runsBattedIn: 0,
  walks: 0,
  strikeouts: 0,
};
const zeroPitcher: OfficialPitcherRecord = {
  playerId: "hp1",
  side: "home",
  battersFaced: 0,
  outsRecorded: 0,
  hits: 0,
  runs: 0,
  earnedRuns: 0,
  walks: 0,
  hitByPitch: 0,
  strikeouts: 0,
};

describe("공식 기록의 계산 행 존재 검증", () => {
  it("동명이인 투수의 실적이 다른 ID에 계산되면 공식 양수 행 누락을 차단한다", async () => {
    const document = await identityConflictFixture();
    const documentHash = stagingDocumentHash(document);
    const replay = compileStagingGameDocumentV2(document);
    const withoutOfficial = compileStagingGameDocumentV2({
      ...document,
      officialRecords: { batters: [], pitchers: [] },
    });

    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([
      {
        code: "official_pitcher_record_missing",
        category: "domain",
        severity: "blocking",
        message: "공식 투수 기록에 양수 실적이 있지만 compiler 계산 기록이 없습니다.",
        gameId: document.metadata.gameId,
        recordIdentity: "pitcher:hp-box",
        details: [
          { field: "battersFaced", expected: 1, actual: null },
          { field: "hits", expected: 1, actual: null },
          { field: "pitches", expected: 1, actual: null },
          { field: "runs", expected: 1, actual: null },
          { field: "strikes", expected: 1, actual: null },
        ],
      },
    ]);
    expect(replay.pitcherLines).toHaveLength(1);
    expect(replay.pitcherLines[0]).toMatchObject({
      playerId: "hp-relay",
      battersFaced: 1,
      hits: 1,
      runs: 1,
    });
    expect({ ...replay, findings: [] }).toEqual({ ...withoutOfficial, findings: [] });
    expect(stagingDocumentHash(document)).toBe(documentHash);
    expect(compileStagingGameDocumentV2(document)).toEqual(replay);
  });

  it.each([
    "plateAppearances",
    "atBats",
    "runs",
    "hits",
    "doubles",
    "triples",
    "homeRuns",
    "runsBattedIn",
    "walks",
    "intentionalWalks",
    "hitByPitch",
    "strikeouts",
    "sacrificeBunts",
    "sacrificeFlies",
  ] as const)("타자의 제공된 %s 양수 실적은 계산 행 없이 통과하지 않는다", (field) => {
    const replay = compileRecords([{ ...zeroBatter, [field]: 1 }], []);

    expect(replay.findings).toEqual([
      expect.objectContaining({
        code: "official_batter_record_missing",
        severity: "blocking",
        recordIdentity: "batter:a1",
        details: [{ field, expected: 1, actual: null }],
      }),
    ]);
    expect(replay.batterLines).toEqual([]);
  });

  it.each([
    "battersFaced",
    "outsRecorded",
    "hits",
    "runs",
    "walks",
    "intentionalWalks",
    "hitByPitch",
    "strikeouts",
    "pitches",
    "strikes",
  ] as const)("투수의 제공된 %s 양수 실적은 계산 행 없이 통과하지 않는다", (field) => {
    const replay = compileRecords([], [{ ...zeroPitcher, [field]: 1 }]);

    expect(replay.findings).toEqual([
      expect.objectContaining({
        code: "official_pitcher_record_missing",
        severity: "blocking",
        recordIdentity: "pitcher:hp1",
        details: [{ field, expected: 1, actual: null }],
      }),
    ]);
    expect(replay.pitcherLines).toEqual([]);
  });

  it("전부 0인 출전 행과 제공되지 않은 선택 필드는 계산 행을 합성하거나 차단하지 않는다", () => {
    const replay = compileRecords([zeroBatter], [zeroPitcher]);
    const explicitOptionalZeros = compileRecords(
      [
        {
          ...zeroBatter,
          plateAppearances: 0,
          doubles: 0,
          triples: 0,
          intentionalWalks: 0,
          hitByPitch: 0,
          sacrificeBunts: 0,
          sacrificeFlies: 0,
        },
      ],
      [{ ...zeroPitcher, intentionalWalks: 0, pitches: 0, strikes: 0 }],
    );

    expect(replay.findings).toEqual([]);
    expect(replay.batterLines).toEqual([]);
    expect(replay.pitcherLines).toEqual([]);
    expect(explicitOptionalZeros).toEqual(replay);
  });

  it("자책점만 양수인 공식 투수 행은 계산 권위 밖의 증거로 보존한다", () => {
    const replay = compileRecords([], [{ ...zeroPitcher, earnedRuns: 1 }]);

    expect(replay.findings).toEqual([]);
    expect(replay.pitcherLines).toEqual([]);
  });

  it("기존 계산 행의 불일치는 기존 필드별 검증을 유지하고 자책점은 비교하지 않는다", async () => {
    const document = await identityConflictFixture();
    const replay = compileStagingGameDocumentV2({
      ...document,
      officialRecords: {
        batters: [],
        pitchers: document.officialRecords.pitchers.map((record) => ({
          ...record,
          playerId: "hp-relay",
          hits: 2,
          earnedRuns: 2,
        })),
      },
    });

    expect(replay.findings.filter((finding) => finding.severity === "blocking")).toEqual([
      expect.objectContaining({
        code: "official_pitcher_record_mismatch",
        recordIdentity: "pitcher:hp-relay",
        details: [{ field: "hits", expected: 2, actual: 1 }],
      }),
    ]);
  });

  it("공식 행의 속성 순서가 달라도 누락 finding과 세부 필드 순서가 결정적이다", async () => {
    const document = await identityConflictFixture();
    const reversed = {
      ...document,
      officialRecords: {
        ...document.officialRecords,
        pitchers: document.officialRecords.pitchers.map((record) =>
          Object.fromEntries(Object.entries(record).reverse()),
        ),
      },
    };

    expect(compileStagingGameDocumentV2(reversed)).toEqual(compileStagingGameDocumentV2(document));
  });
});

function compileRecords(
  batters: readonly OfficialBatterRecord[],
  pitchers: readonly OfficialPitcherRecord[],
) {
  const document = parseStagingGameDocumentV2(makeDocument([]));
  return compileStagingGameDocumentV2({ ...document, officialRecords: { batters, pitchers } });
}

async function identityConflictFixture() {
  return parseStagingGameDocumentV2(
    JSON.parse(
      await readFile("tests/fixtures/official-record-missing.anonymized.json", "utf8"),
    ) as unknown,
  );
}
