import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
  throwIfCancelled,
} from "./errors.js";

export interface NaverHttpOptions {
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly requestsPerSecond?: number;
  readonly baseBackoffMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export class NaverHttpClient {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private limiterTail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  public constructor(options: NaverHttpOptions = {}) {
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
    const requestsPerSecond = options.requestsPerSecond ?? 4;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond는 양수여야 합니다.");
    }
    this.requestIntervalMs = 1_000 / requestsPerSecond;
    this.baseBackoffMs = positiveInteger(options.baseBackoffMs ?? 300, "baseBackoffMs");
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 10 * 1024 * 1024,
      "maxResponseBytes",
    );
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  public async fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
    assertNaverUrl(url);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfCancelled(signal);
      await this.waitForRateLimit(signal);
      try {
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImplementation(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "KBO-Workbench/0.2 (+local)",
          },
          redirect: "follow",
          signal: AbortSignal.any([signal, timeoutSignal]),
        });
        if (response.status === 404) throw new NaverEndpointMissingError();
        if (response.status === 429 || response.status >= 500) {
          lastError = new NaverHttpError(response.status);
        } else if (!response.ok) {
          throw new NaverHttpError(response.status);
        } else {
          return await readJson(response, this.maxResponseBytes);
        }
      } catch (error: unknown) {
        if (signal.aborted) throw new CollectionCancelledError();
        if (
          error instanceof NaverEndpointMissingError ||
          (error instanceof NaverHttpError && error.status < 500 && error.status !== 429) ||
          error instanceof NaverSourceFormatError
        ) {
          throw error;
        }
        lastError = error;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1), signal);
      }
    }
    throw new NaverTransportError(
      `Naver 요청이 ${String(this.maxAttempts)}회 시도 후 실패했습니다.`,
      lastError,
    );
  }

  private async waitForRateLimit(signal: AbortSignal): Promise<void> {
    const previous = this.limiterTail;
    let release: (() => void) | undefined;
    this.limiterTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      throwIfCancelled(signal);
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) await this.sleep(delay, signal);
      this.nextRequestAt = this.now() + this.requestIntervalMs;
    } finally {
      release?.();
    }
  }
}

async function readJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new NaverSourceFormatError("Naver 응답 크기가 안전 제한을 초과했습니다.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxResponseBytes) {
    throw new NaverSourceFormatError("Naver 응답 크기가 안전 제한을 초과했습니다.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NaverSourceFormatError("Naver 자료 항목이 JSON 응답이 아닙니다.");
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

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfCancelled(signal);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new CollectionCancelledError());
      },
      { once: true },
    );
  });
}
