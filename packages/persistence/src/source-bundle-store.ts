import {
  canonicalStringify,
  parseSourceBundleManifest,
  type SourceBundleManifest,
} from "@kbo/contracts";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { atomicWrite, isMissing } from "./workspace-files.js";

export interface ImmutableSourceBundle {
  readonly gameId: string;
  readonly season: number;
  readonly collectedAt: string;
  readonly sourceBundleHash: string;
  readonly payloads: Readonly<Record<string, unknown>>;
  readonly missingEndpoints: readonly string[];
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// The workspace verifies its writer lock before delegating immutable evidence writes.
export async function saveImmutableSourceBundle(
  root: string,
  bundle: ImmutableSourceBundle,
): Promise<void> {
  const calculated = createHash("sha256")
    .update(
      canonicalStringify({
        gameId: bundle.gameId,
        missingEndpoints: [...bundle.missingEndpoints].sort(compareText),
        payloads: bundle.payloads,
      }),
      "utf8",
    )
    .digest("hex");
  if (calculated !== bundle.sourceBundleHash) {
    throw new Error(`source bundle hash가 mapper 결과와 다릅니다: ${bundle.gameId}`);
  }
  const directory = path.join(
    root,
    "source",
    String(bundle.season),
    bundle.gameId,
    bundle.sourceBundleHash,
  );
  await mkdir(directory, { recursive: true });
  const endpoints: Array<{ readonly name: string; readonly hash: string }> = [];
  for (const [name, payload] of Object.entries(bundle.payloads).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) {
      throw new Error(`source endpoint 이름이 올바르지 않습니다: ${name}`);
    }
    const canonical = canonicalStringify(payload);
    const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
    endpoints.push({ name, hash });
    const target = path.join(directory, `${name}.json.gz`);
    try {
      const existing = await readFile(target);
      const existingCanonical = (await gunzipAsync(existing)).toString("utf8");
      if (existingCanonical !== canonical)
        throw new Error(`immutable source가 다릅니다: ${target}`);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await atomicWrite(target, await gzipAsync(Buffer.from(canonical, "utf8"), { level: 9 }));
    }
  }
  const manifest: SourceBundleManifest = {
    gameId: bundle.gameId,
    season: bundle.season,
    collectedAt: new Date(bundle.collectedAt).toISOString(),
    sourceBundleHash: bundle.sourceBundleHash,
    missingEndpoints: [...bundle.missingEndpoints].sort(compareText),
    endpoints,
  };
  const manifestPath = path.join(directory, "manifest.json");
  try {
    const existing = await readFile(manifestPath, "utf8");
    const parsed = parseSourceBundleManifest(JSON.parse(existing) as unknown);
    if (existing !== `${canonicalStringify({ ...manifest, collectedAt: parsed.collectedAt })}\n`) {
      throw new Error(`immutable source manifest가 다릅니다: ${bundle.gameId}`);
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    await atomicWrite(manifestPath, `${canonicalStringify(manifest)}\n`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
