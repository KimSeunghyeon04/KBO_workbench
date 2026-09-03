import { readFile } from "node:fs/promises";

import {
  CorrectionGameCatalogItemSchema,
  parseCollectionJob,
  CorrectionJournalSchema,
  GameCatalogItemSchema,
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
      updatedAt: "2026-08-20T03:00:00.000Z",
    };
    expect(Value.Check(CorrectionGameCatalogItemSchema, candidate)).toBe(true);
    expect(
      Value.Check(CorrectionGameCatalogItemSchema, { ...candidate, blockingFindings: 1 }),
    ).toBe(false);
  });

  it("authority별 필수 필드와 금지 필드를 strict하게 구분한다", () => {
    const workspace = { ...base, authority: "staging", supersededCount: 0 };
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
});
