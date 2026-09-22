import { describe, expect, it, vi } from "vitest";
import { parseStagingRelayEvent } from "@kbo/contracts";
import type { ImmutableSourceBundle } from "@kbo/persistence";
import { SourceEvidenceComputer } from "../../apps/server/src/source-evidence-computation.js";

const event = parseStagingRelayEvent({
  identity: {
    kind: "source",
    eventId: "anonymous",
    endpoint: "relay",
    blockIndex: 0,
    eventIndex: 0,
  },
  sequence: 0,
  inning: 1,
  half: "top",
  kind: "administrative",
  payload: { code: "announcement" },
  relayText: "비식별 원문",
});
const bundle: ImmutableSourceBundle = {
  gameId: "anonymous",
  season: 2026,
  sourceBundleHash: "a".repeat(64),
  collectedAt: "2026-09-13T00:00:00Z",
  missingEndpoints: [],
  payloads: {
    relay: {
      textRelays: [
        {
          textOptions: [
            { seqno: 0, text: "비식별 원문" },
            { seqno: 1, text: "다음 행" },
          ],
          ptsOptions: [],
        },
      ],
    },
  },
};
describe("worker-owned source evidence", () => {
  it("shares verified bundles, returns only evidence, and isolates responses and hash changes", async () => {
    const read = vi.fn(async () => bundle);
    const computer = new SourceEvidenceComputer(read);
    const input = {
      root: "anonymous",
      season: 2026,
      gameId: "anonymous",
      hash: bundle.sourceBundleHash,
      event,
    };
    const [first, second] = await Promise.all([computer.run(input), computer.run(input)]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty("payloads");
    first.relayRows.splice(0);
    expect((await computer.run(input)).relayRows).toHaveLength(2);
    await computer.run({ ...input, hash: "b".repeat(64) });
    expect(read).toHaveBeenCalledTimes(2);
    for (const gameId of ["two", "three", "four", "five"]) await computer.run({ ...input, gameId });
    await computer.run(input);
    expect(read).toHaveBeenCalledTimes(7);
    read.mockRejectedValueOnce(new Error("source hash mismatch"));
    await expect(computer.run({ ...input, hash: "c".repeat(64) })).rejects.toThrow("hash mismatch");
    await computer.run({ ...input, hash: "c".repeat(64) });
    expect(read).toHaveBeenCalledTimes(9);
  });
});
