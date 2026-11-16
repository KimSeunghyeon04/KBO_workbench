import { webkit, type Browser, type BrowserContext } from "playwright";

import { NaverSourceFormatError, NaverTransportError } from "./errors.js";

interface BrowserResponse {
  readonly status: number;
  readonly url: string;
  readonly text: string;
}

export class NaverBrowserTransport {
  private browser: Promise<Browser> | undefined;
  private closed = false;

  public constructor(
    private readonly timeoutMs = 20_000,
    private readonly maxResponseBytes = 10 * 1024 * 1024,
  ) {}

  public async get(url: string, signal: AbortSignal): Promise<BrowserResponse> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("Naver 브라우저 요청 제한 시간을 초과했습니다.")),
      this.timeoutMs,
    );
    const requestSignal = AbortSignal.any([signal, timeout.signal]);
    let context: BrowserContext | undefined;
    const closeOnAbort = (): void => {
      void context?.close().catch(() => undefined);
    };
    requestSignal.addEventListener("abort", closeOnAbort, { once: true });
    try {
      throwIfAborted(requestSignal);
      const browser = await this.getBrowser(requestSignal);
      context = await browser.newContext({ locale: "ko-KR" });
      throwIfAborted(requestSignal);
      const page = await context.newPage();
      throwIfAborted(requestSignal);
      // Read the actual API response through the browser network stack, not the rendered JSON viewer.
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      throwIfAborted(requestSignal);
      if (response === null) throw new NaverTransportError("Naver API 응답을 받지 못했습니다.");
      const declaredLength = Number(response.headers()["content-length"] ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new NaverSourceFormatError("Naver 응답 크기가 안전 제한을 초과했습니다.");
      }
      const body = await response.body();
      throwIfAborted(requestSignal);
      if (body.byteLength > this.maxResponseBytes) {
        throw new NaverSourceFormatError("Naver 응답 크기가 안전 제한을 초과했습니다.");
      }
      return {
        status: response.status(),
        url: response.url(),
        text: new TextDecoder().decode(body),
      };
    } catch (error: unknown) {
      throwIfAborted(requestSignal);
      throw error;
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", closeOnAbort);
      await context?.close().catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    const browser = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    await browser?.close();
  }

  private async getBrowser(signal: AbortSignal): Promise<Browser> {
    if (this.closed) throw new NaverTransportError("Naver 브라우저 전송이 종료되었습니다.");
    let pending = this.browser;
    if (pending === undefined) {
      pending = webkit.launch({ headless: true, timeout: this.timeoutMs });
      this.browser = pending;
      void pending.then(
        (browser) => {
          browser.on("disconnected", () => {
            if (this.browser === pending) this.browser = undefined;
          });
        },
        () => {
          if (this.browser === pending) this.browser = undefined;
        },
      );
    }
    return waitForBrowser(pending, signal);
  }
}

async function waitForBrowser(pending: Promise<Browser>, signal: AbortSignal): Promise<Browser> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (browser) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortReason(signal));
        else resolve(browser);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Naver 요청이 취소되었습니다.");
}
