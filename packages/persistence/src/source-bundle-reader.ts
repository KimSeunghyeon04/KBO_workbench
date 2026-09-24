import { canonicalStringify, parseSourceBundleManifest } from "@kbo/contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { ImmutableSourceBundle } from "./source-bundle-store.js";
import { assertGameId, assertSeason } from "./workspace-path-policy.js";
const gunzipAsync = promisify(gunzip);

export async function readImmutableSourceBundle(
  root: string,
  season: number,
  gameId: string,
  sourceBundleHash: string,
): Promise<ImmutableSourceBundle> {
  assertSeason(season);
  assertGameId(gameId);
  if (!/^[0-9a-f]{64}$/.test(sourceBundleHash)) {
    throw new Error("허용되지 않은 source bundle hash입니다.");
  }
  const directory = path.join(root, "source", String(season), gameId, sourceBundleHash);
  const manifestValue = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  ) as unknown;
  const manifest = parseSourceBundleManifest(manifestValue);
  if (
    manifest.gameId !== gameId ||
    manifest.season !== season ||
    manifest.sourceBundleHash !== sourceBundleHash
  ) {
    throw new Error(`source bundle manifest 문맥이 다릅니다: ${gameId}`);
  }
  const payloads: Record<string, unknown> = {};
  for (const endpoint of manifest.endpoints) {
    const compressed = await readFile(path.join(directory, `${endpoint.name}.json.gz`));
    const canonical = (await gunzipAsync(compressed)).toString("utf8");
    const endpointHash = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (endpointHash !== endpoint.hash) {
      throw new Error(`source endpoint hash가 다릅니다: ${gameId}/${endpoint.name}`);
    }
    const parsed = JSON.parse(canonical) as unknown;
    if (canonicalStringify(parsed) !== canonical) {
      throw new Error(`source endpoint가 canonical JSON이 아닙니다: ${gameId}/${endpoint.name}`);
    }
    payloads[endpoint.name] = parsed;
  }
  const calculated = createHash("sha256")
    .update(
      canonicalStringify({
        gameId,
        missingEndpoints: [...manifest.missingEndpoints].sort(compareText),
        payloads,
      }),
      "utf8",
    )
    .digest("hex");
  if (calculated !== sourceBundleHash) {
    throw new Error(`source bundle hash가 manifest와 다릅니다: ${gameId}`);
  }
  return {
    gameId,
    season,
    collectedAt: manifest.collectedAt,
    sourceBundleHash,
    payloads,
    missingEndpoints: manifest.missingEndpoints,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
