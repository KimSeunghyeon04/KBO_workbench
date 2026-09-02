import { createHash } from "node:crypto";

import { canonicalStringify, type ReplayFramePage, type ReplayManifest } from "@kbo/contracts";
import type { GameRevisionStore } from "@kbo/persistence";
import { buildReplayBundle, DEFAULT_REPLAY_CHUNK_SIZE, type ReplayBundle } from "@kbo/replay";

type ReplayRevisionStore = Pick<GameRevisionStore, "loadCompiled">;

interface ReplayCursorPayload {
  readonly gameId: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly frameHash: string;
  readonly offset: number;
}

interface ReplayCursorEnvelope extends ReplayCursorPayload {
  readonly checksum: string;
}

export class InvalidReplayCursorError extends Error {
  public constructor(message = "replay cursor가 올바르지 않습니다.") {
    super(message);
    this.name = "InvalidReplayCursorError";
  }
}

export class ReplayService {
  public constructor(private readonly revisionStore: ReplayRevisionStore) {}

  public async manifest(gameId: string, revision: number): Promise<ReplayManifest> {
    return (await this.bundle(gameId, revision)).manifest;
  }

  public async frames(
    gameId: string,
    revision: number,
    cursor: string | undefined,
    limit = DEFAULT_REPLAY_CHUNK_SIZE,
  ): Promise<ReplayFramePage> {
    const bundle = await this.bundle(gameId, revision);
    const offset =
      cursor === undefined
        ? 0
        : decodeCursor(cursor, {
            gameId,
            revision,
            documentHash: bundle.manifest.documentHash,
            frameHash: bundle.manifest.frameHash,
          });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new InvalidReplayCursorError("replay frame limit은 1~1000이어야 합니다.");
    }
    if (offset > bundle.frames.length) {
      throw new InvalidReplayCursorError("replay cursor가 frame 범위를 벗어났습니다.");
    }
    const end = Math.min(bundle.frames.length, offset + limit);
    return {
      gameId,
      revision,
      documentHash: bundle.manifest.documentHash,
      frameHash: bundle.manifest.frameHash,
      startIndex: offset,
      frames: bundle.frames.slice(offset, end),
      nextCursor:
        end < bundle.frames.length
          ? encodeCursor({
              gameId,
              revision,
              documentHash: bundle.manifest.documentHash,
              frameHash: bundle.manifest.frameHash,
              offset: end,
            })
          : null,
    };
  }

  private async bundle(gameId: string, revision: number): Promise<ReplayBundle> {
    const stored = await this.revisionStore.loadCompiled(gameId, revision);
    return buildReplayBundle({
      source: stored.source,
      revision: stored.revision,
      documentHash: stored.documentHash,
      projectionHash: stored.projectionHash,
      compiled: stored.replay,
    });
  }
}

function encodeCursor(payload: ReplayCursorPayload): string {
  const envelope: ReplayCursorEnvelope = { ...payload, checksum: cursorChecksum(payload) };
  return Buffer.from(canonicalStringify(envelope), "utf8").toString("base64url");
}

function decodeCursor(value: string, expected: Omit<ReplayCursorPayload, "offset">): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isCursorEnvelope(parsed)) throw new InvalidReplayCursorError();
    const payload: ReplayCursorPayload = {
      gameId: parsed.gameId,
      revision: parsed.revision,
      documentHash: parsed.documentHash,
      frameHash: parsed.frameHash,
      offset: parsed.offset,
    };
    if (parsed.checksum !== cursorChecksum(payload)) throw new InvalidReplayCursorError();
    if (
      payload.gameId !== expected.gameId ||
      payload.revision !== expected.revision ||
      payload.documentHash !== expected.documentHash ||
      payload.frameHash !== expected.frameHash
    ) {
      throw new InvalidReplayCursorError("다른 경기 또는 revision의 replay cursor입니다.");
    }
    return payload.offset;
  } catch (error: unknown) {
    if (error instanceof InvalidReplayCursorError) throw error;
    throw new InvalidReplayCursorError();
  }
}

function cursorChecksum(payload: ReplayCursorPayload): string {
  return createHash("sha256").update(canonicalStringify(payload), "utf8").digest("hex");
}

function isCursorEnvelope(value: unknown): value is ReplayCursorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).sort().join(",") !==
    "checksum,documentHash,frameHash,gameId,offset,revision"
  ) {
    return false;
  }
  return (
    typeof record.gameId === "string" &&
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    typeof record.documentHash === "string" &&
    /^[0-9a-f]{64}$/.test(record.documentHash) &&
    typeof record.frameHash === "string" &&
    /^[0-9a-f]{64}$/.test(record.frameHash) &&
    typeof record.offset === "number" &&
    Number.isInteger(record.offset) &&
    record.offset >= 0 &&
    typeof record.checksum === "string" &&
    /^[0-9a-f]{64}$/.test(record.checksum)
  );
}
