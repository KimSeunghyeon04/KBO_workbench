import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalStringify, type RegistryPageKind } from "@kbo/contracts";

import { atomicWrite } from "./workspace-files.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface StoredRegistryPageMetadata {
  readonly schemaVersion: 1;
  readonly pageKind: RegistryPageKind;
  readonly requestKey: string;
  readonly artifactKey: string;
  readonly contentHash: string;
  readonly collectedAt: string;
}

export interface StoredRegistryPage extends StoredRegistryPageMetadata {
  readonly body: string;
}

export class RegistryWorkspace {
  public constructor(
    private readonly root: string,
    private readonly season: number,
    private readonly runId: string,
  ) {}

  public async savePage(input: {
    readonly pageKind: RegistryPageKind;
    readonly requestKey: string;
    readonly body: string;
    readonly collectedAt: string;
  }): Promise<{ readonly artifactKey: string; readonly contentHash: string }> {
    const artifactKey = this.artifactKey(input.pageKind, input.requestKey);
    const contentHash = createHash("sha256").update(input.body, "utf8").digest("hex");
    const existing = await this.readPage(input.pageKind, input.requestKey);
    if (existing !== null) {
      if (existing.contentHash !== contentHash)
        throw new Error(`resume source page 내용이 변경되었습니다: ${input.requestKey}`);
      return { artifactKey: existing.artifactKey, contentHash: existing.contentHash };
    }
    const absolute = path.join(this.root, ...artifactKey.split("/"));
    await atomicWrite(absolute, await gzipAsync(Buffer.from(input.body, "utf8")));
    const metadata: StoredRegistryPageMetadata = {
      schemaVersion: 1,
      pageKind: input.pageKind,
      requestKey: input.requestKey,
      artifactKey,
      contentHash,
      collectedAt: input.collectedAt,
    };
    await atomicWrite(
      `${absolute}.meta.json`,
      Buffer.from(`${canonicalStringify(metadata)}\n`, "utf8"),
    );
    return { artifactKey, contentHash };
  }

  public async readPage(
    pageKind: RegistryPageKind,
    requestKey: string,
  ): Promise<StoredRegistryPage | null> {
    const artifactKey = this.artifactKey(pageKind, requestKey);
    const absolute = path.join(this.root, ...artifactKey.split("/"));
    try {
      const metadata = decodeMetadata(
        JSON.parse(await readFile(`${absolute}.meta.json`, "utf8")) as unknown,
      );
      const body = (await gunzipAsync(await readFile(absolute))).toString("utf8");
      const contentHash = createHash("sha256").update(body, "utf8").digest("hex");
      if (
        metadata.pageKind !== pageKind ||
        metadata.requestKey !== requestKey ||
        metadata.artifactKey !== artifactKey ||
        metadata.contentHash !== contentHash
      ) {
        throw new Error(`registry source page manifest 불일치: ${requestKey}`);
      }
      return { ...metadata, body };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private artifactKey(pageKind: RegistryPageKind, requestKey: string): string {
    const digest = createHash("sha256").update(requestKey, "utf8").digest("hex").slice(0, 16);
    const safe = requestKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    return [
      "registry",
      "source",
      String(this.season),
      this.runId,
      pageKind,
      `${safe}-${digest}.${pageKind === "register" ? "html" : "json"}.gz`,
    ].join("/");
  }
}

function decodeMetadata(value: unknown): StoredRegistryPageMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("registry source page metadata가 객체가 아닙니다.");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !==
      "artifactKey,collectedAt,contentHash,pageKind,requestKey,schemaVersion" ||
    item.schemaVersion !== 1 ||
    (item.pageKind !== "register" && item.pageKind !== "trade") ||
    typeof item.requestKey !== "string" ||
    typeof item.artifactKey !== "string" ||
    typeof item.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.contentHash) ||
    typeof item.collectedAt !== "string"
  ) {
    throw new Error("registry source page metadata 계약이 올바르지 않습니다.");
  }
  return {
    schemaVersion: 1,
    pageKind: item.pageKind,
    requestKey: item.requestKey,
    artifactKey: item.artifactKey,
    contentHash: item.contentHash,
    collectedAt: item.collectedAt,
  };
}
