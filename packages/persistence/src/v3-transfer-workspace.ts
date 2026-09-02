import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalStringify,
  parseStagingGameDocumentV2,
  type StagingGameDocumentV2,
} from "@kbo/contracts";

import type { V2ExportedCurrentGame } from "./v2-current-export.js";
import { atomicWrite, isMissing } from "./workspace-files.js";
import { assertGameId } from "./workspace-path-policy.js";

export interface V3TransferGameManifest {
  readonly gameId: string;
  readonly artifactKey: string;
  readonly artifactSha256: string;
  readonly sourceRevision: number;
  readonly sourceDocumentHash: string;
  readonly sourceProjectionHash: string;
  readonly sourceBundleHash: string;
  readonly sourceContentHash: string;
  readonly normalizedDocumentHash: string;
  readonly compilerHash: string;
  readonly replaySemanticHash: string;
}

export interface V3TransferManifest {
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly sourceAnalyticsContractVersion: 2;
  readonly sourceProjectionVersion: 2;
  readonly targetAnalyticsContractVersion: 3;
  readonly targetProjectionVersion: 3;
  readonly gameCount: number;
  readonly games: readonly V3TransferGameManifest[];
}

export interface V3TransferGameArtifact {
  readonly document: StagingGameDocumentV2;
  readonly sourceRevision: number;
  readonly sourceDocumentHash: string;
  readonly sourceProjectionHash: string;
  readonly sourceBundleHash: string;
  readonly sourceContentHash: string;
  readonly normalizedDocumentHash: string;
  readonly compilerHash: string;
  readonly replaySemanticHash: string;
}

export class V3TransferWorkspace {
  public constructor(private readonly root: string) {}

  public async initializeEmpty(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await assertAbsent(path.join(this.root, "manifest.json"));
    await mkdir(path.join(this.root, "games"), { recursive: true });
  }

  public async writeGame(game: V2ExportedCurrentGame): Promise<V3TransferGameManifest> {
    const gameId = game.document.metadata.gameId;
    assertGameId(gameId);
    const artifactKey = `games/${gameId}.json.gz`;
    const target = path.join(this.root, ...artifactKey.split("/"));
    await assertAbsent(target);
    const artifact: V3TransferGameArtifact = {
      document: game.document,
      sourceRevision: game.sourceRevision,
      sourceDocumentHash: game.sourceDocumentHash,
      sourceProjectionHash: game.sourceProjectionHash,
      sourceBundleHash: game.sourceBundleHash,
      sourceContentHash: game.sourceContentHash,
      normalizedDocumentHash: game.normalizedDocumentHash,
      compilerHash: game.compilerHash,
      replaySemanticHash: game.replaySemanticHash,
    };
    const compressed = gzipSync(`${canonicalStringify(artifact)}\n`, { level: 9 });
    await atomicWrite(target, compressed);
    return {
      gameId,
      artifactKey,
      artifactSha256: sha256(compressed),
      sourceRevision: game.sourceRevision,
      sourceDocumentHash: game.sourceDocumentHash,
      sourceProjectionHash: game.sourceProjectionHash,
      sourceBundleHash: game.sourceBundleHash,
      sourceContentHash: game.sourceContentHash,
      normalizedDocumentHash: game.normalizedDocumentHash,
      compilerHash: game.compilerHash,
      replaySemanticHash: game.replaySemanticHash,
    };
  }

  public async writeManifest(
    games: readonly V3TransferGameManifest[],
  ): Promise<V3TransferManifest> {
    const sorted = [...games].sort((left, right) => left.gameId.localeCompare(right.gameId));
    const manifest: V3TransferManifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      sourceAnalyticsContractVersion: 2,
      sourceProjectionVersion: 2,
      targetAnalyticsContractVersion: 3,
      targetProjectionVersion: 3,
      gameCount: sorted.length,
      games: sorted,
    };
    await atomicWrite(path.join(this.root, "manifest.json"), `${canonicalStringify(manifest)}\n`);
    return manifest;
  }

  public async readManifest(): Promise<V3TransferManifest> {
    return parseManifest(
      JSON.parse(await readFile(path.join(this.root, "manifest.json"), "utf8")) as unknown,
    );
  }

  public async readGame(entry: V3TransferGameManifest): Promise<V3TransferGameArtifact> {
    if (entry.artifactKey !== `games/${entry.gameId}.json.gz`) {
      throw new Error(`V3 transfer artifact key가 결정론적 경로와 다릅니다: ${entry.gameId}`);
    }
    const bytes = await readFile(path.join(this.root, ...entry.artifactKey.split("/")));
    if (sha256(bytes) !== entry.artifactSha256) {
      throw new Error(`V3 transfer artifact hash가 다릅니다: ${entry.gameId}`);
    }
    const value = JSON.parse(gunzipSync(bytes).toString("utf8")) as unknown;
    return parseArtifact(value, entry);
  }
}

function parseManifest(value: unknown): V3TransferManifest {
  const record = object(value, "V3 transfer manifest");
  if (
    record.formatVersion !== 1 ||
    record.sourceAnalyticsContractVersion !== 2 ||
    record.sourceProjectionVersion !== 2 ||
    record.targetAnalyticsContractVersion !== 3 ||
    record.targetProjectionVersion !== 3 ||
    typeof record.createdAt !== "string" ||
    !Array.isArray(record.games) ||
    !Number.isSafeInteger(record.gameCount) ||
    record.gameCount !== record.games.length
  ) {
    throw new Error("지원하지 않거나 손상된 V3 transfer manifest입니다.");
  }
  const games = record.games.map(parseManifestGame);
  const ids = games.map((game) => game.gameId);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && id <= (ids[index - 1] ?? ""))
  ) {
    throw new Error("V3 transfer manifest game 순서 또는 유일성이 잘못되었습니다.");
  }
  return {
    formatVersion: 1,
    createdAt: record.createdAt,
    sourceAnalyticsContractVersion: 2,
    sourceProjectionVersion: 2,
    targetAnalyticsContractVersion: 3,
    targetProjectionVersion: 3,
    gameCount: games.length,
    games,
  };
}

function parseManifestGame(value: unknown): V3TransferGameManifest {
  const record = object(value, "V3 transfer game manifest");
  const gameId = string(record.gameId, "gameId");
  assertGameId(gameId);
  const parsed: V3TransferGameManifest = {
    gameId,
    artifactKey: string(record.artifactKey, "artifactKey"),
    artifactSha256: hash(record.artifactSha256, "artifactSha256"),
    sourceRevision: positiveInteger(record.sourceRevision, "sourceRevision"),
    sourceDocumentHash: hash(record.sourceDocumentHash, "sourceDocumentHash"),
    sourceProjectionHash: hash(record.sourceProjectionHash, "sourceProjectionHash"),
    sourceBundleHash: hash(record.sourceBundleHash, "sourceBundleHash"),
    sourceContentHash: hash(record.sourceContentHash, "sourceContentHash"),
    normalizedDocumentHash: hash(record.normalizedDocumentHash, "normalizedDocumentHash"),
    compilerHash: hash(record.compilerHash, "compilerHash"),
    replaySemanticHash: hash(record.replaySemanticHash, "replaySemanticHash"),
  };
  if (Object.keys(record).sort().join(",") !== Object.keys(parsed).sort().join(",")) {
    throw new Error(`V3 transfer game manifest에 알 수 없는 필드가 있습니다: ${gameId}`);
  }
  return parsed;
}

function parseArtifact(value: unknown, entry: V3TransferGameManifest): V3TransferGameArtifact {
  const record = object(value, "V3 transfer artifact");
  const document = parseStagingGameDocumentV2(record.document);
  const artifact: V3TransferGameArtifact = {
    document,
    sourceRevision: positiveInteger(record.sourceRevision, "sourceRevision"),
    sourceDocumentHash: hash(record.sourceDocumentHash, "sourceDocumentHash"),
    sourceProjectionHash: hash(record.sourceProjectionHash, "sourceProjectionHash"),
    sourceBundleHash: hash(record.sourceBundleHash, "sourceBundleHash"),
    sourceContentHash: hash(record.sourceContentHash, "sourceContentHash"),
    normalizedDocumentHash: hash(record.normalizedDocumentHash, "normalizedDocumentHash"),
    compilerHash: hash(record.compilerHash, "compilerHash"),
    replaySemanticHash: hash(record.replaySemanticHash, "replaySemanticHash"),
  };
  const comparable = { ...entry };
  delete (comparable as { artifactKey?: string }).artifactKey;
  delete (comparable as { artifactSha256?: string }).artifactSha256;
  delete (comparable as { gameId?: string }).gameId;
  if (
    document.metadata.gameId !== entry.gameId ||
    canonicalStringify(artifact) !== canonicalStringify({ document, ...comparable })
  ) {
    throw new Error(`V3 transfer artifact와 manifest가 다릅니다: ${entry.gameId}`);
  }
  if (Object.keys(record).sort().join(",") !== Object.keys(artifact).sort().join(",")) {
    throw new Error(`V3 transfer artifact에 알 수 없는 필드가 있습니다: ${entry.gameId}`);
  }
  return artifact;
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await readFile(target);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`기존 V3 transfer artifact를 덮어쓰지 않습니다: ${target}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}는 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label}가 잘못되었습니다.`);
  return value;
}

function hash(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error(`${label}가 잘못되었습니다.`);
  return Number(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
