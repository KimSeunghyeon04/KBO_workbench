export interface RetryingHttpTransportOptions {
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly requestsPerSecond?: number;
  readonly timeoutMs?: number;
  readonly baseBackoffMs?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export interface TransportRequest<T> {
  readonly url: string;
  readonly init: RequestInit;
  readonly signal?: AbortSignal;
  readonly decode: (response: Response) => Promise<T>;
  readonly retryable: (error: unknown) => boolean;
}

export interface TransportResult<T> {
  readonly value: T;
  readonly receivedAt: string;
}

export class HttpStatusError extends Error {
  public constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${String(status)}: ${url}`);
    this.name = "HttpStatusError";
  }
}

export class HttpTransportExhaustedError extends Error {
  public constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`HTTP 요청이 ${String(attempts)}회 시도 후 실패했습니다.`, { cause });
    this.name = "HttpTransportExhaustedError";
  }
}

export class RetryingHttpTransport {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly requestIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private limiterTail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  public constructor(options: RetryingHttpTransportOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
    this.baseBackoffMs = positiveInteger(options.baseBackoffMs ?? 250, "baseBackoffMs");
    const requestsPerSecond = options.requestsPerSecond ?? 2;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond는 양수여야 합니다.");
    }
    this.requestIntervalMs = 1_000 / requestsPerSecond;
    this.sleep = options.sleep ?? abortableDelay;
    this.now = options.now ?? Date.now;
  }

  public async request<T>(request: TransportRequest<T>): Promise<TransportResult<T>> {
    const signal = request.signal ?? new AbortController().signal;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      await this.waitForRateLimit(signal);
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new Error("HTTP 요청 제한 시간을 초과했습니다.")),
        this.timeoutMs,
      );
      try {
        const response = await this.fetchImplementation(request.url, {
          ...request.init,
          signal: AbortSignal.any([signal, timeoutController.signal]),
        });
        if (!response.ok) throw new HttpStatusError(response.status, request.url);
        const value = await request.decode(response);
        return { value, receivedAt: new Date(this.now()).toISOString() };
      } catch (error: unknown) {
        if (signal.aborted) throw abortReason(signal);
        lastError = error;
        if (!request.retryable(error)) throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.baseBackoffMs * 2 ** (attempt - 1), signal);
      }
    }
    throw new HttpTransportExhaustedError(this.maxAttempts, lastError);
  }

  private async waitForRateLimit(signal: AbortSignal): Promise<void> {
    const previous = this.limiterTail;
    let release: (() => void) | undefined;
    this.limiterTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      throwIfAborted(signal);
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) await this.sleep(delay, signal);
      this.nextRequestAt = this.now() + this.requestIntervalMs;
    } finally {
      release?.();
    }
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
  error: () => Error,
): Promise<string> {
  const limit = positiveInteger(maxResponseBytes, "maxResponseBytes");
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw error();
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw error();
  return text.replace(/^\uFEFF/, "");
}

export function responseCookies(headers: Headers): string | null {
  const cookies = headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0);
  return cookies.length === 0 ? null : cookies.join("; ");
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("HTTP 요청이 취소되었습니다.");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}
