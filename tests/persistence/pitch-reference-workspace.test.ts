import { createHash } from "node:crypto";
import { mkdtempDisposable, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalStringify,
  PitchReferenceEnvelopeSchema,
  type PitchReferenceKey,
} from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

const key: PitchReferenceKey = {
  modelVersion: 2,
  calibrationHash: null,
  referenceVersion: 2,
  season: 2024,
  sourceHash: "a".repeat(64),
};
const relative = path.join(
  "analysis",
  "pitch-reference",
  "v2",
  "reference-v2",
  "source-plane",
  "2024",
  `${key.sourceHash}.json`,
);

describe("persistent season pitch reference", () => {
  it("coalesces concurrent calculation and reuses even an empty baseline after restart", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-reference-"));
    let workspace = await StagingWorkspace.open(temporary.path);
    const calculate = vi.fn(async () => null);
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => workspace.pitchReferences.getOrCreate(key, calculate)),
      );
      expect(results).toEqual(Array.from({ length: 8 }, () => null));
      expect(calculate).toHaveBeenCalledTimes(1);
      const stored: unknown = JSON.parse(
        await readFile(path.join(temporary.path, relative), "utf8"),
      );
      expect(Value.Check(PitchReferenceEnvelopeSchema, stored)).toBe(true);
      expect(await readdir(path.dirname(path.join(temporary.path, relative)))).toEqual([
        `${key.sourceHash}.json`,
      ]);
      await workspace.close();
      workspace = await StagingWorkspace.open(temporary.path);
      expect(await workspace.pitchReferences.getOrCreate(key, calculate)).toBeNull();
      expect(calculate).toHaveBeenCalledTimes(1);
      await workspace.pitchReferences.getOrCreate({ ...key, season: 2025 }, calculate);
      await workspace.pitchReferences.getOrCreate(
        { ...key, sourceHash: "b".repeat(64) },
        calculate,
      );
      expect(calculate).toHaveBeenCalledTimes(3);
      await workspace.pitchReferences.getOrCreate(
        { ...key, calibrationHash: "c".repeat(64) },
        calculate,
      );
      expect(calculate).toHaveBeenCalledTimes(4);
      await workspace.pitchReferences.getOrCreate(key, calculate);
      expect(calculate).toHaveBeenCalledTimes(4);
    } finally {
      await workspace.close();
    }
  });

  it.each(["json", "hash", "schema", "model", "source"])(
    "rebuilds a damaged or mismatched %s artifact",
    async (damage) => {
      await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-reference-"));
      const workspace = await StagingWorkspace.open(temporary.path);
      const calculate = vi.fn(async () => null);
      try {
        await workspace.pitchReferences.getOrCreate(key, calculate);
        const payload = {
          ...key,
          reference: null,
          ...(damage === "model" ? { modelVersion: 3 } : {}),
          ...(damage === "source" ? { sourceHash: "b".repeat(64) } : {}),
          ...(damage === "schema" ? { unexpected: true } : {}),
        };
        const hash = createHash("sha256").update(canonicalStringify(payload)).digest("hex");
        await writeFile(
          path.join(temporary.path, relative),
          damage === "json"
            ? "{"
            : JSON.stringify({ hash: damage === "hash" ? "0".repeat(64) : hash, payload }),
        );
        expect(await workspace.pitchReferences.getOrCreate(key, calculate)).toBeNull();
        expect(calculate).toHaveBeenCalledTimes(2);
      } finally {
        await workspace.close();
      }
    },
  );

  it("retries failed calculations and refuses writes without the workspace lock", async () => {
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-reference-"));
    const workspace = await StagingWorkspace.open(temporary.path);
    try {
      await expect(
        workspace.pitchReferences.getOrCreate(key, async () => {
          throw new Error("query failed");
        }),
      ).rejects.toThrow("query failed");
      expect(await workspace.pitchReferences.getOrCreate(key, async () => null)).toBeNull();
    } finally {
      await workspace.close();
    }
    await expect(
      workspace.pitchReferences.getOrCreate(
        { ...key, sourceHash: "c".repeat(64) },
        async () => null,
      ),
    ).rejects.toThrow();
  });
});
