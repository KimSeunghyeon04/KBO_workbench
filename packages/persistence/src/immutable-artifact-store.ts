import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

import {
  canonicalStringify,
  parseImmutableArtifactMetadata,
  type ImmutableArtifactMetadata,
} from "@kbo/contracts";

import { atomicWrite, isMissing } from "./workspace-files.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface ImmutableTextArtifact<K extends string> extends ImmutableArtifactMetadata {
  readonly pageKind: K;
  readonly body: string;
}

interface ImmutableArtifactStoreOptions<K extends string> {
  readonly root: string;
  readonly artifactKey: (pageKind: K, requestKey: string) => string;
  readonly isPageKind: (value: string) => value is K;
  readonly mismatchMessage: (requestKey: string) => string;
}

export class ImmutableTextArtifactStore<K extends string> {
  public constructor(private readonly options: ImmutableArtifactStoreOptions<K>) {}

  public async save(input: {
    readonly pageKind: K;
    readonly requestKey: string;
    readonly body: string;
    readonly collectedAt: string;
  }): Promise<{ readonly artifactKey: string; readonly contentHash: string }> {
    const artifactKey = this.options.artifactKey(input.pageKind, input.requestKey);
    const contentHash = sha256(input.body);
    const existing = await this.read(input.pageKind, input.requestKey);
    if (existing !== null) {
      if (existing.contentHash !== contentHash) {
        throw new Error(this.options.mismatchMessage(input.requestKey));
      }
      return { artifactKey: existing.artifactKey, contentHash: existing.contentHash };
    }
    const absolute = this.absoluteArtifactPath(artifactKey);
    await atomicWrite(absolute, await gzipAsync(Buffer.from(input.body, "utf8")));
    const metadata = parseImmutableArtifactMetadata({
      schemaVersion: 1,
      pageKind: input.pageKind,
      requestKey: input.requestKey,
      artifactKey,
      contentHash,
      collectedAt: input.collectedAt,
    });
    await atomicWrite(`${absolute}.meta.json`, `${canonicalStringify(metadata)}\n`);
    return { artifactKey, contentHash };
  }

  public async read(pageKind: K, requestKey: string): Promise<ImmutableTextArtifact<K> | null> {
    const artifactKey = this.options.artifactKey(pageKind, requestKey);
    const absolute = this.absoluteArtifactPath(artifactKey);
    try {
      const metadata = parseImmutableArtifactMetadata(
        JSON.parse(await readFile(`${absolute}.meta.json`, "utf8")) as unknown,
      );
      const body = (await gunzipAsync(await readFile(absolute))).toString("utf8");
      if (
        !this.options.isPageKind(metadata.pageKind) ||
        metadata.pageKind !== pageKind ||
        metadata.requestKey !== requestKey ||
        metadata.artifactKey !== artifactKey ||
        metadata.contentHash !== sha256(body)
      ) {
        throw new Error(this.options.mismatchMessage(requestKey));
      }
      return { ...metadata, pageKind: metadata.pageKind, body };
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private absoluteArtifactPath(artifactKey: string): string {
    const absolute = path.resolve(this.options.root, ...artifactKey.split("/"));
    const root = path.resolve(this.options.root);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error("immutable artifact가 workspace root 밖을 가리킵니다.");
    }
    return absolute;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
