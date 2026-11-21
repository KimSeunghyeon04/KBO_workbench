import { describe, expect, it, vi } from "vitest";

import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpClient,
  NaverTransportError,
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

  it("취소 후 transport가 정상 본문을 늦게 반환해도 성공으로 처리하지 않는다", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error("cancelled during response delivery"));
      return Response.json({ ok: true });
    });
    const client = new NaverHttpClient({ fetch: fetchMock, requestsPerSecond: 1000 });
    await expect(client.fetchJson(url, controller.signal)).rejects.toBeInstanceOf(
      CollectionCancelledError,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([200, 404])(
    "제한 시간 뒤 늦게 도착한 HTTP %s 응답도 시간 초과로 처리한다",
    async (status) => {
      vi.useFakeTimers();
      try {
        let deliver: ((response: Response) => void) | undefined;
        const fetchMock = vi.fn<typeof fetch>(
          () =>
            new Promise<Response>((resolve) => {
              deliver = resolve;
            }),
        );
        const client = new NaverHttpClient({ fetch: fetchMock, timeoutMs: 10, maxAttempts: 1 });
        const pending = client.fetchJson(url, new AbortController().signal);
        const failed = expect(pending).rejects.toBeInstanceOf(NaverTransportError);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10);
        if (deliver === undefined) throw new Error("fetch did not start");
        deliver(Response.json({ ok: true }, { status }));
        await failed;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([404, 503])("HTTP %s 오류 본문을 해제한 뒤 종료 또는 재시도한다", async (status) => {
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel }), { status }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new NaverHttpClient({
      fetch: fetchMock,
      requestsPerSecond: 1000,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    if (status === 404) {
      await expect(client.fetchJson(url, new AbortController().signal)).rejects.toBeInstanceOf(
        NaverEndpointMissingError,
      );
    } else {
      await expect(client.fetchJson(url, new AbortController().signal)).resolves.toEqual({
        ok: true,
      });
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(status === 404 ? 1 : 2);
  });

  it("오류 본문 정리 실패가 원래 HTTP 오류 분류를 덮어쓰지 않는다", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 404 }));
    const client = new NaverHttpClient({ fetch: fetchMock });
    await expect(client.fetchJson(url, new AbortController().signal)).rejects.toBeInstanceOf(
      NaverEndpointMissingError,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
