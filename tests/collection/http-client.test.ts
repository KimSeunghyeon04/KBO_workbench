import { describe, expect, it, vi } from "vitest";

import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpClient,
} from "@kbo/collection";

const url = "https://api-gw.sports.naver.com/schedule/games/G1/relay";

describe("Naver HTTP client", () => {
  it("retry 가능한 응답에 backoff 후 다시 요청한다", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const client = new NaverHttpClient({
      fetch: fetchMock,
      sleep,
      maxAttempts: 2,
      requestsPerSecond: 1000,
      now: () => 0,
    });
    await expect(client.fetchJson(url, new AbortController().signal)).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("404를 retry하지 않고 endpoint missing으로 분류한다", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("missing", { status: 404 }));
    const client = new NaverHttpClient({ fetch: fetchMock, requestsPerSecond: 1000 });
    await expect(client.fetchJson(url, new AbortController().signal)).rejects.toBeInstanceOf(
      NaverEndpointMissingError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("사용자 AbortSignal을 transport failure로 바꾸지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new NaverHttpClient({ fetch: vi.fn(), requestsPerSecond: 1000 });
    await expect(client.fetchJson(url, controller.signal)).rejects.toBeInstanceOf(
      CollectionCancelledError,
    );
  });

  it("본문을 읽는 중 취소해도 reader를 해제하고 수집 취소로 분류한다", async () => {
    const controller = new AbortController();
    let response: Response | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      response = new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
      );
      return response;
    });
    const client = new NaverHttpClient({ fetch: fetchMock, requestsPerSecond: 1000 });
    const pending = client.fetchJson(url, controller.signal);
    const cancelled = expect(pending).rejects.toBeInstanceOf(CollectionCancelledError);
    await vi.waitFor(() => expect(response?.body?.locked).toBe(true));
    controller.abort();
    await cancelled;
    expect(response?.body?.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
