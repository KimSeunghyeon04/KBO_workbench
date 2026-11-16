import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CollectionCancelledError,
  NaverHttpClient,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
  PlaywrightScheduleExplorer,
} from "@kbo/collection";

import { scheduleGame, schedulePayload } from "../../../tests/helpers/naver.js";

const browser = vi.hoisted(() => ({
  launch: vi.fn(),
  newContext: vi.fn(),
  goto: vi.fn(),
  closeContext: vi.fn(),
  closeBrowser: vi.fn(),
  on: vi.fn(),
}));

vi.mock("playwright", () => ({ webkit: { launch: browser.launch } }));

const apiUrl = "https://api-gw.sports.naver.com/schedule/games";
const gameUrl = `${apiUrl}/G1/relay`;

function response(text: string, status = 200, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    url: () => apiUrl,
    headers: () => headers,
    body: vi.fn(async () => new TextEncoder().encode(text)),
  };
}

function browserInstance() {
  return { newContext: browser.newContext, close: browser.closeBrowser, on: browser.on };
}

beforeEach(() => {
  vi.resetAllMocks();
  browser.closeContext.mockResolvedValue(undefined);
  browser.closeBrowser.mockResolvedValue(undefined);
  browser.launch.mockResolvedValue(browserInstance());
  browser.newContext.mockImplementation(async () => ({
    newPage: async () => ({ goto: browser.goto }),
    close: browser.closeContext,
  }));
});

describe("WebKit headless Naver 전송", () => {
  it("브라우저 탐색으로 일정의 모든 page를 읽고 HTTP 원문과 pagination 조건을 보존한다", async () => {
    const pages = [
      schedulePayload([scheduleGame("G2", "2026-07-02"), scheduleGame("G1", "2026-07-01")], 3),
      schedulePayload([scheduleGame("G1", "2026-07-01")], 3),
    ];
    browser.goto
      .mockResolvedValueOnce(response(JSON.stringify(pages[0])))
      .mockResolvedValueOnce(response(JSON.stringify(pages[1])));
    const observe = vi.fn(async () => undefined);
    const games = await new PlaywrightScheduleExplorer().discoverRange(
      "2026-07-01",
      "2026-07-02",
      new AbortController().signal,
      observe,
    );
    expect(games.map((game) => game.gameId)).toEqual(["G1", "G2"]);
    expect(browser.launch).toHaveBeenCalledExactlyOnceWith({ headless: true, timeout: 20_000 });
    for (const [index, call] of browser.goto.mock.calls.entries()) {
      const input: unknown = call[0];
      expect(typeof input).toBe("string");
      if (typeof input !== "string") throw new Error("Missing browser URL");
      const url = new URL(input);
      expect(url.origin + url.pathname).toBe(apiUrl);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        fields: "basic,schedule,baseball,manualRelayUrl",
        upperCategoryId: "kbaseball",
        categoryIds: "kbo",
        fromDate: "2026-07-01",
        toDate: "2026-07-02",
        size: "500",
        page: String(index + 1),
      });
      expect(call[1]).toEqual({ waitUntil: "domcontentloaded", timeout: 20_000 });
      expect(observe).toHaveBeenNthCalledWith(index + 1, index + 1, {
        status: 200,
        url: apiUrl,
        payload: pages[index],
      });
    }
    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(browser.closeContext).toHaveBeenCalledTimes(2);
    expect(browser.closeBrowser).toHaveBeenCalledOnce();
  });

  it.each([403, 200])(
    "비 JSON HTTP %s 응답도 원문을 남기고 완료 일정으로 처리하지 않는다",
    async (status) => {
      const text = "<html>source unavailable</html>";
      browser.goto.mockResolvedValue(response(text, status));
      const observe = vi.fn(async () => undefined);
      await expect(
        new PlaywrightScheduleExplorer().discoverRange(
          "2026-07-01",
          "2026-07-01",
          new AbortController().signal,
          observe,
        ),
      ).rejects.toBeInstanceOf(status === 403 ? NaverHttpError : NaverSourceFormatError);
      expect(observe).toHaveBeenCalledWith(1, { status, url: apiUrl, payload: text });
      expect(browser.closeContext).toHaveBeenCalledOnce();
      expect(browser.closeBrowser).toHaveBeenCalledOnce();
    },
  );

  it("이미 취소된 일정 요청은 브라우저를 실행하지 않는다", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new PlaywrightScheduleExplorer().discoverRange("2026-07-01", "2026-07-01", controller.signal),
    ).rejects.toBeInstanceOf(CollectionCancelledError);
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("실제 경기 HTTP 요청도 같은 브라우저 경로로 재시도하고 종료 시 브라우저를 닫는다", async () => {
    browser.goto
      .mockResolvedValueOnce(response("busy", 503))
      .mockResolvedValueOnce(response('{"ok":true}'));
    const client = new NaverHttpClient({
      maxAttempts: 2,
      requestsPerSecond: 1000,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    try {
      await expect(client.fetchJson(gameUrl, new AbortController().signal)).resolves.toEqual({
        ok: true,
      });
      expect(browser.goto).toHaveBeenCalledTimes(2);
      expect(browser.launch).toHaveBeenCalledOnce();
      expect(browser.closeContext).toHaveBeenCalledTimes(2);
      expect(browser.closeBrowser).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
    expect(browser.closeBrowser).toHaveBeenCalledOnce();
  });

  it.each(["declared", "actual"])("%s 응답 크기 초과는 재시도하지 않고 거부한다", async (kind) => {
    const source = response(
      '{"value":"large"}',
      200,
      kind === "declared" ? { "content-length": "999" } : {},
    );
    browser.goto.mockResolvedValue(source);
    const client = new NaverHttpClient({ maxResponseBytes: 4, requestsPerSecond: 1000 });
    try {
      await expect(client.fetchJson(gameUrl, new AbortController().signal)).rejects.toBeInstanceOf(
        NaverSourceFormatError,
      );
      expect(browser.goto).toHaveBeenCalledOnce();
      if (kind === "declared") expect(source.body).not.toHaveBeenCalled();
      expect(browser.closeContext).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("진행 중 요청 취소는 해당 context만 닫으며 다음 경기 요청과 브라우저를 유지한다", async () => {
    const controller = new AbortController();
    browser.goto.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("page closed");
    });
    const client = new NaverHttpClient({ requestsPerSecond: 1000 });
    try {
      await expect(client.fetchJson(gameUrl, controller.signal)).rejects.toBeInstanceOf(
        CollectionCancelledError,
      );
      expect(browser.closeContext).toHaveBeenCalled();
      expect(browser.closeBrowser).not.toHaveBeenCalled();
      browser.goto.mockResolvedValue(response('{"recovered":true}'));
      await expect(client.fetchJson(gameUrl, new AbortController().signal)).resolves.toEqual({
        recovered: true,
      });
      expect(browser.launch).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("응답이 멈추면 시간 제한으로 context를 닫고 transport 실패를 반환한다", async () => {
    let rejectNavigation: ((error: Error) => void) | undefined;
    browser.goto.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectNavigation = reject;
        }),
    );
    browser.closeContext.mockImplementation(async () =>
      rejectNavigation?.(new Error("page closed")),
    );
    const client = new NaverHttpClient({ timeoutMs: 20, maxAttempts: 1, requestsPerSecond: 1000 });
    try {
      await expect(client.fetchJson(gameUrl, new AbortController().signal)).rejects.toBeInstanceOf(
        NaverTransportError,
      );
      expect(browser.closeContext).toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
