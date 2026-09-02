import {
  ReplayFramePageSchema,
  ReplayManifestSchema,
  RevisionCatalogSchema,
  type ReplayFrame,
  type ReplayManifest,
  type RevisionCatalog,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { requestJson } from "./transport";

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
  const frames: ReplayFrame[] = [];
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
  } while (cursor !== undefined);
  if (frames.length !== manifest.frameCount) {
    throw new Error("재생 frame 수가 manifest와 일치하지 않습니다.");
  }
  return { manifest, frames };
}
