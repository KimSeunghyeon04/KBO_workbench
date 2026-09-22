import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { correctionSourceEvidenceQueryOptions } from "../../apps/web/src/api/query-options.js";
import { ApiClientError } from "../../apps/web/src/api/transport.js";
import { retryQuery, retryQueryDelay } from "../../apps/web/src/api/query-retry.js";

afterEach(() => vi.unstubAllGlobals());
describe("correction evidence cache and startup retry", () => {
  it("reuses evidence within a version and reloads after a pitch ID correction", async () => {
    const client = new QueryClient();
    let pitchId = "old";
    const fetch = vi.fn(async () =>
      Response.json({
        eventId: "e2",
        endpoint: "relay",
        blockIndex: 0,
        eventIndex: 2,
        relayRows: [],
        trackingRows: [{ rowIndex: 0, sourcePitchId: pitchId, canonicalJson: "{}" }],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const first = await client.fetchQuery(
        correctionSourceEvidenceQueryOptions("session", "e2", 0),
      );
      await client.fetchQuery(correctionSourceEvidenceQueryOptions("session", "e2", 0));
      expect(fetch).toHaveBeenCalledTimes(1);
      pitchId = "corrected";
      const next = await client.fetchQuery(
        correctionSourceEvidenceQueryOptions("session", "e2", 1),
      );
      expect(first.trackingRows[0]?.sourcePitchId).toBe("old");
      expect(next.trackingRows[0]?.sourcePitchId).toBe("corrected");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      client.clear();
    }
  });
  it("extends only initialization retries and keeps them bounded", () => {
    const starting = new ApiClientError(
      "준비 중",
      503,
      "startup",
      "server_initializing",
      "persistence",
      true,
      [],
    );
    expect(retryQuery(149, starting)).toBe(true);
    expect(retryQuery(150, starting)).toBe(false);
    expect(retryQueryDelay(100, starting)).toBe(2000);
    expect(retryQuery(1, new Error("other failure"))).toBe(false);
  });
});
