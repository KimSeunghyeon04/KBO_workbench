import { describe, expect, it } from "vitest";

import { NaverEndpointMissingError, NaverGameCollector, type JsonClient } from "@kbo/collection";

describe("Naver game collector", () => {
  it("필수 endpoint 누락을 source failure로 유지한다", async () => {
    const client: JsonClient = {
      async fetchJson(url) {
        if (url.endsWith("/relay")) {
          return { result: { textRelayData: { inningScore: { away: { "1": "0" } } } } };
        }
        if (url.endsWith("/record")) throw new NaverEndpointMissingError();
        return {};
      },
    };
    const result = await new NaverGameCollector(client).collect("G1", new AbortController().signal);
    expect(result.disposition).toBe("source_failure");
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "source.endpoint_missing", endpoint: "record" }),
    ]);
  });
});
