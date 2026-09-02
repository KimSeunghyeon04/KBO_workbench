import { createHash } from "node:crypto";

import {
  ImmutableTextArtifactStore,
  type ImmutableTextArtifact,
} from "./immutable-artifact-store.js";

type PageKind = "landing" | "control" | "records";
export type StoredRecordCorrectionPage = ImmutableTextArtifact<PageKind>;

export class RecordCorrectionWorkspace {
  private readonly store: ImmutableTextArtifactStore<PageKind>;

  public constructor(root: string, season: number, runId: string) {
    this.store = new ImmutableTextArtifactStore({
      root,
      artifactKey: (pageKind, requestKey) =>
        recordCorrectionArtifactKey(season, runId, pageKind, requestKey),
      isPageKind: (value): value is PageKind =>
        value === "landing" || value === "control" || value === "records",
      mismatchMessage: (requestKey) =>
        `record correction source가 변경되었거나 manifest가 다릅니다: ${requestKey}`,
    });
  }

  public async savePage(input: {
    readonly pageKind: PageKind;
    readonly requestKey: string;
    readonly body: string;
    readonly collectedAt: string;
  }): Promise<{ readonly artifactKey: string; readonly contentHash: string }> {
    return this.store.save(input);
  }

  public async readPage(
    pageKind: PageKind,
    requestKey: string,
  ): Promise<StoredRecordCorrectionPage | null> {
    return this.store.read(pageKind, requestKey);
  }
}

function recordCorrectionArtifactKey(
  season: number,
  runId: string,
  pageKind: PageKind,
  requestKey: string,
): string {
  const digest = createHash("sha256").update(requestKey, "utf8").digest("hex").slice(0, 16);
  const safe = requestKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const extension = pageKind === "landing" ? "html" : "json";
  return [
    "record-corrections",
    "source",
    String(season),
    runId,
    pageKind,
    `${safe}-${digest}.${extension}.gz`,
  ].join("/");
}
