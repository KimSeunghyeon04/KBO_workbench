import { createHash } from "node:crypto";

import type { RegistryPageKind } from "@kbo/contracts";

import {
  ImmutableTextArtifactStore,
  type ImmutableTextArtifact,
} from "./immutable-artifact-store.js";

export type StoredRegistryPage = ImmutableTextArtifact<RegistryPageKind>;

export class RegistryWorkspace {
  private readonly store: ImmutableTextArtifactStore<RegistryPageKind>;

  public constructor(root: string, season: number, runId: string) {
    this.store = new ImmutableTextArtifactStore({
      root,
      artifactKey: (pageKind, requestKey) =>
        registryArtifactKey(season, runId, pageKind, requestKey),
      isPageKind: (value): value is RegistryPageKind => value === "register" || value === "trade",
      mismatchMessage: (requestKey) =>
        `registry resume source page 내용이 변경되었거나 manifest가 다릅니다: ${requestKey}`,
    });
  }

  public async savePage(input: {
    readonly pageKind: RegistryPageKind;
    readonly requestKey: string;
    readonly body: string;
    readonly collectedAt: string;
  }): Promise<{ readonly artifactKey: string; readonly contentHash: string }> {
    return this.store.save(input);
  }

  public async readPage(
    pageKind: RegistryPageKind,
    requestKey: string,
  ): Promise<StoredRegistryPage | null> {
    return this.store.read(pageKind, requestKey);
  }
}

function registryArtifactKey(
  season: number,
  runId: string,
  pageKind: RegistryPageKind,
  requestKey: string,
): string {
  const digest = createHash("sha256").update(requestKey, "utf8").digest("hex").slice(0, 16);
  const safe = requestKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return [
    "registry",
    "source",
    String(season),
    runId,
    pageKind,
    `${safe}-${digest}.${pageKind === "register" ? "html" : "json"}.gz`,
  ].join("/");
}
