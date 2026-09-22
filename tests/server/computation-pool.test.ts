import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  parseSourceBundleManifest,
  parseStagingGameDocumentV2,
} from "@kbo/contracts";
import { applyCorrectionCommand, CorrectionCommandError } from "@kbo/correction";
import { NaverSourceEvidenceError } from "@kbo/collection";
import { compileStagingGameDocumentV2 } from "@kbo/game-core";
import {
  StagingWorkspace,
  calculatePitchCalibration,
  buildRelationalProjection,
  type PitchAnalysisRow,
} from "@kbo/persistence";
import { stagingDocumentHash } from "@kbo/game-core";
import { createRevisionProjectionComputation } from "../../apps/server/src/computation.js";
import { ComputationPool, ComputationBusyError } from "../../apps/server/src/computation-pool.js";
import { calibrationRows } from "../helpers/pitch-calibration.js";

const document = parseStagingGameDocumentV2(
  JSON.parse(await readFile("tests/fixtures/game-document-v2.golden.json", "utf8")) as unknown,
);
const command = {
  kind: "delete_event" as const,
  commandId: "anon-delete",
  eventId: document.events[0]?.identity.eventId ?? "missing",
};

describe("bounded shared compiler workers", () => {
  it("prepares isolated correction responses and preserves V3/V4 projection hashes", async () => {
    const pool = new ComputationPool(1);
    try {
      const result = await pool.run({ kind: "compile", document, storedFindings: [] });
      if (result.kind !== "compile" || result.snapshot === undefined)
        throw new Error("missing snapshot");
      expect(result.snapshot.draftDocument).toEqual(document);
      expect(result.snapshot.draftDocumentHash).toBe(stagingDocumentHash(document));
      expect(result.snapshot.eventContexts).toHaveLength(result.value.frames.length);
      result.snapshot.draftDocument.events.splice(0);
      const repeated = await pool.run({ kind: "compile", document, storedFindings: [] });
      if (repeated.kind !== "compile") throw new Error("unexpected result");
      expect(repeated.snapshot?.draftDocument.events).toHaveLength(document.events.length);
      const computation = createRevisionProjectionComputation(pool);
      for (const version of [3, 4] as const) {
        const projection = await computation.project(document, result.value, 1, version);
        expect(projection).toEqual(buildRelationalProjection(document, result.value, 1, version));
        expect(await computation.hash(projection.tables, version)).toBe(projection.projectionHash);
      }
    } finally {
      await pool.close();
    }
  });

  it("validates immutable source bytes, canonical form and aggregate hash in the worker", async () => {
    await using temp = await mkdtempDisposable(path.join(tmpdir(), "kbo-source-worker-"));
    const workspace = await StagingWorkspace.open(temp.path);
    const pool = new ComputationPool(1);
    const gameId = "anon-source",
      payloads = {
        preview: { textRelays: [{ textOptions: [{ seqno: 0, text: "비식별 원문" }] }] },
      };
    const hash = createHash("sha256")
      .update(canonicalStringify({ gameId, missingEndpoints: [], payloads }))
      .digest("hex");
    const bundle = {
      gameId,
      season: 2026,
      collectedAt: "2026-09-13T00:00:00.000Z",
      sourceBundleHash: hash,
      payloads,
      missingEndpoints: [],
    };
    const input = { kind: "source_bundle" as const, root: temp.path, gameId, season: 2026, hash };
    const dir = path.join(temp.path, "source", "2026", gameId, hash);
    try {
      await workspace.saveSourceBundle(bundle);
      expect(await pool.run(input)).toEqual({
        kind: "source_bundle",
        value: { bundle, bytes: Buffer.byteLength(JSON.stringify(bundle), "utf8") },
      });
      expect(await pool.run({ ...input, kind: "player_heights" })).toEqual({
        kind: "player_heights",
        value: { gameId, season: 2026, sourceBundleHash: hash, observations: [] },
      });
      const first = document.events[0];
      if (first === undefined || first.identity.kind !== "source")
        throw new Error("missing source fixture");
      const event = {
        ...first,
        identity: { ...first.identity, endpoint: "preview", blockIndex: 0, eventIndex: 0 },
      };
      const evidenceInput = { ...input, kind: "source_evidence" as const, event };
      const evidence = await pool.run(evidenceInput);
      if (evidence.kind !== "source_evidence") throw new Error("unexpected evidence");
      expect(evidence.value.relayRows).toHaveLength(1);
      expect(evidence.value).not.toHaveProperty("payloads");
      await expect(
        pool.run({
          ...evidenceInput,
          event: { ...event, identity: { ...event.identity, eventIndex: 99 } },
        }),
      ).rejects.toBeInstanceOf(NaverSourceEvidenceError);
      await expect(pool.run({ ...input, gameId: "../escape" })).rejects.toThrow();
      const manifest = parseSourceBundleManifest(
        JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")) as unknown,
      );
      await writeFile(path.join(dir, "preview.json.gz"), gzipSync('{"changed":true}'));
      await expect(pool.run(input)).rejects.toThrow("endpoint hash");
      await expect(pool.run({ ...input, kind: "player_heights" })).rejects.toThrow("endpoint hash");
      for (const [raw, error] of [
        ['{ "score": 1, "status": "final" }', "canonical JSON"],
        ['{"changed":true}', "bundle hash"],
      ]) {
        if (raw === undefined || error === undefined) throw new Error("fixture missing");
        const changed = {
          ...manifest,
          endpoints: manifest.endpoints.map((entry) => ({
            ...entry,
            hash: createHash("sha256").update(raw).digest("hex"),
          })),
        };
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify(changed));
        await writeFile(path.join(dir, "preview.json.gz"), gzipSync(raw));
        await expect(pool.run(input)).rejects.toThrow(error);
      }
    } finally {
      await pool.close();
      await workspace.close();
    }
  });
  it("returns identical strict compile/command results, keeps timers available, and recovers from command errors", async () => {
    const pool = new ComputationPool(1);
    try {
      let complete = false;
      const pending = pool.run({ kind: "compile", document }).then((result) => {
        complete = true;
        return result;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(complete).toBe(false);
      expect(await pending).toEqual({
        kind: "compile",
        value: compileStagingGameDocumentV2(document),
      });
      await pool.warmup();
      expect(await pool.run({ kind: "command", document, command })).toEqual({
        kind: "command",
        value: applyCorrectionCommand(document, command),
      });
      await expect(
        pool.run({ kind: "command", document, command: { ...command, eventId: "missing" } }),
      ).rejects.toBeInstanceOf(CorrectionCommandError);
      expect((await pool.run({ kind: "compile", document })).kind).toBe("compile");
    } finally {
      await pool.close();
    }
  });

  it("bounds queued work, cancels active work without losing the queue, and closes both", async () => {
    const pool = new ComputationPool(1, 1);
    const controller = new AbortController();
    try {
      const active = pool.run({ kind: "compile", document }, controller.signal);
      const cancelled = expect(active).rejects.toThrow("cancelled");
      const queued = pool.run({ kind: "compile", document });
      await expect(pool.run({ kind: "compile", document })).rejects.toBeInstanceOf(
        ComputationBusyError,
      );
      controller.abort();
      await cancelled;
      expect((await queued).kind).toBe("compile");
      const closing = Promise.allSettled([
        pool.run({ kind: "compile", document }),
        pool.run({ kind: "compile", document }),
      ]);
      await pool.close();
      expect((await closing).every((item) => item.status === "rejected")).toBe(true);
      await expect(pool.run({ kind: "compile", document })).rejects.toThrow("closed");
    } finally {
      await pool.close();
    }
  });

  it("transfers all season rows in bounded chunks", async () => {
    const row: PitchAnalysisRow = {
      gameId: "anonymous",
      revision: 1,
      pitchId: "pitch",
      gameDate: "2024-01-01",
      stadium: null,
      stance: null,
      balls: 0,
      strikes: 0,
      pitcherId: "pitcher",
      pitchType: null,
      speedKph: null,
      swing: false,
      whiff: false,
      trackingId: null,
      supported: false,
      x0: null,
      y0: null,
      z0: null,
      vx0: null,
      vy0: null,
      vz0: null,
      ax: null,
      ay: null,
      az: null,
      crossPlateY: null,
    };
    const pool = new ComputationPool(1);
    try {
      const result = await pool.run({
        kind: "pitch_sample",
        calibration: { modelVersion: 1, season: 2024, sourceHash: "a".repeat(64), profiles: [] },
        season: 2024,
        pitcherId: "pitcher",
        sourceHash: "a".repeat(64),
        rows: Array.from({ length: 10001 }, () => row),
        reference: null,
      });
      expect(result.kind).toBe("pitch_sample");
      if (result.kind !== "pitch_sample") throw new Error("unexpected result");
      expect(result.value).toMatchObject({ actualPitchCount: 10001, missingTrackingCount: 10001 });
    } finally {
      await pool.close();
    }
  });

  it("fits daily calibration from chunked rows identically in the worker", async () => {
    const rows = calibrationRows();
    const pool = new ComputationPool(1);
    try {
      const result = await pool.run({
        kind: "pitch_calibration",
        season: 2025,
        sourceHash: "a".repeat(64),
        rows,
        previous: null,
      });
      expect(result.kind).toBe("pitch_calibration");
      if (result.kind !== "pitch_calibration") throw new Error("Unexpected result");
      expect(result.value).toEqual(calculatePitchCalibration(2025, "a".repeat(64), rows));
      expect(result.value.profiles.at(-1)?.status).toBe("ready");
    } finally {
      await pool.close();
    }
  });
});
