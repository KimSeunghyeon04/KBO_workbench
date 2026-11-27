import {
  canonicalStringify,
  ReplayCatalogCalendarSchema,
  ReplayCatalogPageSchema,
  ReplayFramePageSchema,
  ReplayManifestSchema,
  RevisionCatalogSchema,
  type ReplayFrame,
  type ReplayCatalogQuery,
  type ReplayManifest,
  type RevisionCatalog,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

export async function getReplayCatalogPage(query: ReplayCatalogQuery, signal: AbortSignal) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  return Value.Decode(
    ReplayCatalogPageSchema,
    await requestJson(`/api/v2/replay/games?${params}`, { signal }),
  );
}

export async function getReplayCatalogCalendar(signal: AbortSignal) {
  return Value.Decode(
    ReplayCatalogCalendarSchema,
    await requestJson("/api/v2/replay/calendar", { signal }),
  );
}

export async function getRevisionCatalog(gameId: string): Promise<RevisionCatalog> {
  return Value.Decode(
    RevisionCatalogSchema,
    await requestJson(`/api/v2/games/${encodeURIComponent(gameId)}/revisions`),
  );
}
export interface LoadedReplay {
  readonly manifest: ReplayManifest;
  readonly frames: readonly ReplayFrame[];
}
export async function loadReplay(gameId: string, revision: number): Promise<LoadedReplay> {
  const root = `/api/v2/games/${encodeURIComponent(gameId)}/revisions/${String(revision)}`;
  const manifest = Value.Decode(ReplayManifestSchema, await requestJson(`${root}/replay-manifest`));
  if (manifest.gameId !== gameId || manifest.revision !== revision) {
    throw new Error("재생 manifest가 요청한 경기 버전과 다릅니다.");
  }
  const frames: ReplayFrame[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(manifest.defaultChunkSize) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const page = Value.Decode(
      ReplayFramePageSchema,
      await requestJson(`${root}/replay-frames?${query.toString()}`),
    );
    if (
      page.gameId !== manifest.gameId ||
      page.revision !== manifest.revision ||
      page.documentHash !== manifest.documentHash ||
      page.frameHash !== manifest.frameHash ||
      page.startIndex !== frames.length
    ) {
      throw new Error("재생 frame 묶음의 revision 또는 순서가 manifest와 일치하지 않습니다.");
    }
    frames.push(...page.frames);
    cursor = page.nextCursor ?? undefined;
    if (
      frames.length > manifest.frameCount ||
      (cursor !== undefined && (page.frames.length === 0 || cursors.has(cursor)))
    ) {
      throw new Error("재생 페이지가 진행되지 않거나 요청한 frame 수를 초과했습니다.");
    }
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  if (frames.length !== manifest.frameCount) {
    throw new Error("재생 frame 수가 manifest와 일치하지 않습니다.");
  }
  const plays = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    if (
      frame.gameId !== gameId ||
      frame.revision !== revision ||
      frame.playNumber !== index + 1 ||
      plays.has(frame.playId) ||
      (index > 0 && frame.sequence <= (frames[index - 1]?.sequence ?? -1))
    ) {
      throw new Error("재생 frame의 경기 버전 또는 플레이 순서가 올바르지 않습니다.");
    }
    plays.add(frame.playId);
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("재생 무결성 검증을 위해 localhost 또는 HTTPS 주소로 접속해 주세요.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalStringify(frames)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== manifest.frameHash)
    throw new Error("재생 frame 내용의 해시가 manifest와 일치하지 않습니다.");
  return { manifest, frames };
}
