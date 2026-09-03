import { readFile } from "node:fs/promises";

import {
  CorrectionGameCatalogItemSchema,
  CurrentWorkspaceEntrySchema,
  parseCollectionJob,
  CorrectionJournalSchema,
  GameCatalogItemSchema,
  RecordCorrectionCaseSchema,
  RecordCorrectionListItemSchema,
  parseSourceBundleManifest,
  parseSourceFailureRecord,
  parseStoredFindings,
  parseWriterLockOwner,
} from "@kbo/contracts";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

const base = {
  gameId: "anon-game-1",
  season: 2026,
  updatedAt: "2026-08-30T00:00:00.000Z",
  blockingFindings: 0,
  warningFindings: 1,
};

describe("catalog authority union과 workspace file codec", () => {
  it("보정 후보 요약은 finding count 없이 strict하게 검증한다", () => {
    const candidate = {
      gameId: "20260715AABB0",
      season: 2026,
      authority: "quarantine",
      gameDate: "2026-07-15",
      teams: {
        away: { teamId: "away", name: "비식별 원정" },
        home: { teamId: "home", name: "비식별 홈" },
      },
      updatedAt: "2026-08-20T03:00:00.000Z",
    };
    expect(Value.Check(CorrectionGameCatalogItemSchema, candidate)).toBe(true);
    expect(
      Value.Check(CorrectionGameCatalogItemSchema, { ...candidate, blockingFindings: 1 }),
    ).toBe(false);
  });

  it("authority별 필수 필드와 금지 필드를 strict하게 구분한다", () => {
    const workspace = {
      ...base,
      authority: "staging",
      gameDate: "2026-08-30",
      teams: {
        away: { teamId: "away", name: "비식별 원정" },
        home: { teamId: "home", name: "비식별 홈" },
      },
      supersededCount: 0,
    };
    const database = {
      ...base,
      authority: "database",
      gameDate: "2026-08-30",
      teams: {
        away: { teamId: "away", name: "비식별 원정" },
        home: { teamId: "home", name: "비식별 홈" },
      },
      currentRevision: 2,
      revisionCount: 2,
    };
    expect(Value.Check(GameCatalogItemSchema, workspace)).toBe(true);
    expect(Value.Check(GameCatalogItemSchema, database)).toBe(true);
    expect(Value.Check(GameCatalogItemSchema, { ...database, teams: undefined })).toBe(false);
    expect(Value.Check(GameCatalogItemSchema, { ...workspace, currentRevision: 1 })).toBe(false);
    expect(Value.Check(GameCatalogItemSchema, { ...database, unknown: true })).toBe(false);
    expect(
      Value.Check(GameCatalogItemSchema, {
        gameId: "unobserved-source-failure",
        season: null,
        authority: "source_failure",
        updatedAt: "2026-08-30T00:00:00.000Z",
        blockingFindings: 1,
        warningFindings: 0,
        supersededCount: 0,
      }),
    ).toBe(true);
    expect(
      Value.Check(GameCatalogItemSchema, {
        gameId: "unobserved-source-failure",
        season: null,
        authority: "source_failure",
        gameDate: "2026-08-30",
        updatedAt: "2026-08-30T00:00:00.000Z",
        blockingFindings: 1,
        warningFindings: 0,
        supersededCount: 0,
      }),
    ).toBe(false);
  });

  it("current manifest V2는 문서 요약을 요구하고 source failure는 null만 허용한다", () => {
    const common = {
      schemaVersion: 2,
      gameId: "anon-game-1",
      generation: 1,
      updatedAt: "2026-08-30T00:00:00.000Z",
      artifactPath: `active/anon-game-1/1-${"a".repeat(64)}.document.json`,
      contentHash: "a".repeat(64),
    };
    const ready = {
      ...common,
      season: 2026,
      authority: "ready",
      documentHash: "b".repeat(64),
      displaySummary: {
        gameDate: "2026-08-30",
        teams: {
          away: { teamId: "away", name: "비식별 원정" },
          home: { teamId: "home", name: "비식별 홈" },
        },
      },
    };
    expect(Value.Check(CurrentWorkspaceEntrySchema, ready)).toBe(true);
    expect(Value.Check(CurrentWorkspaceEntrySchema, { ...ready, displaySummary: undefined })).toBe(
      false,
    );
    expect(Value.Check(CurrentWorkspaceEntrySchema, { ...ready, unknown: true })).toBe(false);
    expect(
      Value.Check(CurrentWorkspaceEntrySchema, {
        ...common,
        artifactPath: `active/anon-game-1/1-${"a".repeat(64)}.failure.json`,
        season: null,
        authority: "source_failure",
        documentHash: null,
        displaySummary: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(CurrentWorkspaceEntrySchema, {
        ...common,
        artifactPath: `active/anon-game-1/1-${"a".repeat(64)}.failure.json`,
        season: null,
        authority: "source_failure",
        documentHash: null,
        displaySummary: ready.displaySummary,
      }),
    ).toBe(false);
  });

  it("finding, source manifest/failure, lock 파일의 잘못된 값과 추가 필드를 거부한다", () => {
    expect(() =>
      parseStoredFindings([
        { code: "source.test", category: "source", severity: "warning", message: "test", extra: 1 },
      ]),
    ).toThrow();
    const finding = {
      producer: "collection" as const,
      lifecycle: "persistent" as const,
      code: "source.test",
      category: "source" as const,
      severity: "blocking" as const,
      message: "비식별 원천 오류",
    };
    expect(() =>
      parseSourceFailureRecord({
        gameId: "anon-game-1",
        season: null,
        recordedAt: "2026-08-30T00:00:00.000Z",
        findingEnvelope: { schemaVersion: 2, findings: [finding] },
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseSourceBundleManifest({
        gameId: "anon-game-1",
        season: 2026,
        collectedAt: "2026-08-30T00:00:00.000Z",
        sourceBundleHash: "a".repeat(64),
        missingEndpoints: [],
        endpoints: [{ name: "relay", hash: "not-a-hash" }],
      }),
    ).toThrow();
    expect(() =>
      parseWriterLockOwner({ token: "owner", pid: -1, hostname: "host", acquiredAt: "invalid" }),
    ).toThrow();
  });

  it("correction journal도 strict 문서 계약 전체를 적용한다", async () => {
    const document = JSON.parse(
      await readFile("tests/fixtures/game-document-v2.golden.json", "utf8"),
    ) as unknown;
    const journal = {
      baseAuthority: "staging",
      targetAuthority: "staging",
      baseDocumentHash: "a".repeat(64),
      document,
      findingEnvelope: { schemaVersion: 2, findings: [] },
      beforeDocument: document,
      createdAt: "2026-08-30T00:00:00.000Z",
    };
    expect(Value.Check(CorrectionJournalSchema, journal)).toBe(true);
    expect(Value.Check(CorrectionJournalSchema, { ...journal, extra: true })).toBe(false);
  });

  it("오래된 collection journal의 누락 필드를 암묵적으로 backfill하지 않는다", () => {
    expect(() =>
      parseCollectionJob({
        jobId: "legacy-job",
        kind: "collection",
        status: "running",
        createdAt: "2026-08-30T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        completedItems: 0,
        totalItems: null,
        currentGameId: null,
        summary: { ready: 0, quarantined: 0, sourceFailures: 0 },
        error: null,
      }),
    ).toThrow();
  });

  it("collection job은 요청 scope와 건너뜀 수를 보존한다", () => {
    expect(
      parseCollectionJob({
        jobId: "collection-job",
        kind: "collection",
        status: "succeeded",
        createdAt: "2026-08-30T00:00:00.000Z",
        startedAt: "2026-08-30T00:00:01.000Z",
        finishedAt: "2026-08-30T00:00:02.000Z",
        completedItems: 2,
        totalItems: 2,
        currentGameId: null,
        scope: { kind: "game_ids", gameIds: ["anon-game-1", "anon-game-2"] },
        summary: { ready: 1, quarantined: 0, sourceFailures: 0 },
        skippedItems: 1,
        error: null,
        errorCategory: null,
      }),
    ).toMatchObject({
      scope: { kind: "game_ids", gameIds: ["anon-game-1", "anon-game-2"] },
      skippedItems: 1,
    });
  });

  it("기록정정 목록 DTO는 상세 계약과 분리되고 추가 필드를 거부한다", () => {
    const item = {
      noticeId: "2024:0:10",
      caseVersion: 1,
      status: "manual_review",
      season: 2024,
      gameId: "anon-game",
      assessedAt: "2026-09-01T00:00:00.000Z",
      gameDate: "2024-09-15",
      awayTeamName: "비식별 원정",
      homeTeamName: "비식별 홈",
      venueName: "비식별 구장",
      beforeRecordText: "안타",
      afterRecordText: "실책",
    };
    expect(Value.Check(RecordCorrectionListItemSchema, item)).toBe(true);
    expect(Value.Check(RecordCorrectionListItemSchema, { ...item, candidates: [] })).toBe(false);
    expect(Value.Check(RecordCorrectionCaseSchema, item)).toBe(false);
  });
});
