import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
  type StoredFinding,
} from "@kbo/contracts";
import { stagingDocumentHash } from "@kbo/game-core";

import { atomicWrite, isMissing, removeIfPresent } from "./workspace-files.js";
import { findingEnvelope, readFindings } from "./workspace-findings.js";
import { assertGameId, assertSeason } from "./workspace-path-policy.js";

// The owning workspace verifies its writer lock before saving the immutable original.
export class WorkspaceOriginalStore {
  public constructor(private readonly root: string) {}

  public async readDocument(season: number, gameId: string): Promise<StagingGameDocumentV2> {
    return parseStagingGameDocumentV2(
      JSON.parse(await readFile(this.documentPath(season, gameId), "utf8")) as unknown,
    );
  }

  public async readFindings(season: number, gameId: string): Promise<readonly StoredFinding[]> {
    return readFindings(this.findingsPath(season, gameId));
  }

  public async saveIfAbsent(
    document: StagingGameDocumentV2,
    findings: readonly StoredFinding[],
  ): Promise<void> {
    const target = this.documentPath(document.metadata.season, document.metadata.gameId);
    try {
      const existing = parseStagingGameDocumentV2(
        JSON.parse(await readFile(target, "utf8")) as unknown,
      );
      if (existing.metadata.gameId !== document.metadata.gameId) {
        throw new Error(`원본 gameId가 현재 경기와 다릅니다: ${document.metadata.gameId}`);
      }
      return;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const findingsTarget = this.findingsPath(document.metadata.season, document.metadata.gameId);
    if (findings.length === 0) {
      await removeIfPresent(findingsTarget);
    } else {
      await atomicWrite(findingsTarget, `${canonicalStringify(findingEnvelope(findings))}\n`);
    }
    await atomicWrite(target, `${canonicalStringify(document)}\n`);
    const stored = parseStagingGameDocumentV2(
      JSON.parse(await readFile(target, "utf8")) as unknown,
    );
    if (stagingDocumentHash(stored) !== stagingDocumentHash(document)) {
      throw new Error(`원본 문서 hash 검증에 실패했습니다: ${document.metadata.gameId}`);
    }
  }

  private documentPath(season: number, gameId: string): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, "original", String(season), `${gameId}.json`);
  }

  private findingsPath(season: number, gameId: string): string {
    assertSeason(season);
    assertGameId(gameId);
    return path.join(this.root, "original", String(season), `${gameId}.findings.json`);
  }
}
