import { createHash } from "node:crypto";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalStringify } from "@kbo/contracts";
import { StagingWorkspace } from "@kbo/persistence";
import { compute } from "../../apps/server/src/computation-executor.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

it("extracts both ordered datasets after reading each archived source file once", async () => {
  await using dir = await mkdtempDisposable(path.join(tmpdir(), "kbo-player-evidence-"));
  const workspace = await StagingWorkspace.open(dir.path);
  try {
    const gameId = "anonymous-import-source";
    const season = 2026;
    const payloads = {
      lineup: {
        result: {
          previewData: {
            awayTeamLineUp: { fullLineUp: [{ pcode: "a1", height: "185", batsThrows: "좌타" }] },
          },
        },
      },
      relay_summary: {
        result: {
          textRelayData: {
            awayLineup: { batter: [{ pcode: "a2", height: "178", hitType: "우투우타" }] },
          },
        },
      },
    };
    const missingEndpoints: string[] = [];
    const hash = createHash("sha256")
      .update(canonicalStringify({ gameId, missingEndpoints, payloads }), "utf8")
      .digest("hex");
    await workspace.saveSourceBundle({
      gameId,
      season,
      collectedAt: "2026-06-01T10:00:00Z",
      sourceBundleHash: hash,
      payloads,
      missingEndpoints,
    });
    vi.mocked(readFile).mockClear();
    const result = await compute({ kind: "player_evidence", root: dir.path, season, gameId, hash });
    expect(result).toMatchObject({
      kind: "player_evidence",
      value: {
        heights: {
          gameId,
          season,
          sourceBundleHash: hash,
          observations: [
            { playerId: "a1", heightCm: 185, endpoint: "lineup" },
            { playerId: "a2", heightCm: 178, endpoint: "relay_summary" },
          ],
        },
        battingProfiles: {
          gameId,
          season,
          sourceBundleHash: hash,
          observations: [
            { playerId: "a1", battingSide: "L", endpoint: "lineup" },
            { playerId: "a2", battingSide: "R", endpoint: "relay_summary" },
          ],
        },
      },
    });
    const directory = path.join(dir.path, "source", String(season), gameId, hash);
    expect(
      vi
        .mocked(readFile)
        .mock.calls.map(([target]) => String(target))
        .filter((target) => target.startsWith(directory + path.sep)),
    ).toEqual(
      ["manifest.json", "lineup.json.gz", "relay_summary.json.gz"].map((name) =>
        path.join(directory, name),
      ),
    );
  } finally {
    await workspace.close();
  }
});
