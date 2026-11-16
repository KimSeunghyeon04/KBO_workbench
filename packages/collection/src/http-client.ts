import { NaverBrowserTransport } from "./browser-transport.js";
import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
} from "./errors.js";
import {
  HttpStatusError,
  HttpTransportExhaustedError,
  readBoundedResponseText,
  RetryingHttpTransport,
  type RetryingHttpTransportOptions,
} from "./http-transport.js";

export interface NaverHttpOptions extends RetryingHttpTransportOptions {
  readonly maxResponseBytes?: number;
}

export class NaverHttpClient {
  private readonly transport: RetryingHttpTransport;
  private readonly maxResponseBytes: number;
  private readonly browserTransport: NaverBrowserTransport | undefined;

  public constructor(options: NaverHttpOptions = {}) {
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 10 * 1024 * 1024,
      "maxResponseBytes",
    );
    const browserTransport =
      options.fetch === undefined
        ? new NaverBrowserTransport(options.timeoutMs ?? 15_000, this.maxResponseBytes)
        : undefined;
    this.browserTransport = browserTransport;
    this.transport = new RetryingHttpTransport({
      ...options,
      ...(browserTransport === undefined
        ? {}
        : {
            fetch: async (input, init) => {
              if (typeof input !== "string") throw new Error("Naver URL 문자열이 필요합니다.");
              const response = await browserTransport.get(
                input,
                init?.signal ?? new AbortController().signal,
              );
              return new Response(
                [204, 205, 304].includes(response.status) ? null : response.text,
                { status: response.status },
              );
            },
          }),
      requestsPerSecond: options.requestsPerSecond ?? 4,
      baseBackoffMs: options.baseBackoffMs ?? 300,
    });
  }

  public async close(): Promise<void> {
    await this.browserTransport?.close();
  }

  public async fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
    assertNaverUrl(url);
    try {
      const result = await this.transport.request({
        url,
        signal,
        init: {
          headers: {
            Accept: "application/json",
            "User-Agent": "KBO-Workbench/0.2 (+local)",
          },
          redirect: "follow",
        },
        retryable: (error) =>
          error instanceof HttpStatusError
            ? error.status === 429 || error.status >= 500
            : !(error instanceof NaverSourceFormatError),
        decode: async (response) => {
          const text = await readBoundedResponseText(
            response,
            this.maxResponseBytes,
            () => new NaverSourceFormatError("Naver 응답 크기가 안전 제한을 초과했습니다."),
          );
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new NaverSourceFormatError("Naver 자료 항목이 JSON 응답이 아닙니다.");
          }
        },
      });
      return result.value;
    } catch (error: unknown) {
      if (signal.aborted) throw new CollectionCancelledError();
      if (error instanceof HttpStatusError) {
        if (error.status === 404) throw new NaverEndpointMissingError();
        throw new NaverHttpError(error.status);
      }
      if (error instanceof NaverSourceFormatError) throw error;
      if (error instanceof HttpTransportExhaustedError) {
        throw new NaverTransportError(error.message, error.cause);
      }
      throw new NaverTransportError("Naver 요청 transport가 실패했습니다.", error);
    }
  }
}

function assertNaverUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api-gw.sports.naver.com") {
    throw new Error("허용되지 않은 Naver endpoint입니다.");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}
