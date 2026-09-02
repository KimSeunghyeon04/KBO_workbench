import { throwIfCancelled } from "../errors.js";

const LANDING_URL = "https://www.koreabaseball.com/Record/RecordCorrect/RecordCorrect.aspx";
const YEAR_CONTROL_URL = "https://www.koreabaseball.com/ws/Controls.asmx/GetRecordCorrectYear";
const SERIES_CONTROL_URL = "https://www.koreabaseball.com/ws/Controls.asmx/GetRecordCorrectSeries";
const RECORDS_URL = "https://www.koreabaseball.com/ws/Record.asmx/GetRecordCorrectList";

export interface KboRecordCorrectionHttpOptions {
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly requestsPerSecond?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface KboRecordCorrectionRawPage {
  readonly body: string;
  readonly collectedAt: string;
}

export class KboRecordCorrectionHttpClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private nextRequestAt = 0;
  private rateGate: Promise<void> = Promise.resolve();
  private cookie: string | null = null;

  public constructor(options: KboRecordCorrectionHttpOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.minimumIntervalMs = 1_000 / (options.requestsPerSecond ?? 2);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  public async landing(signal?: AbortSignal): Promise<KboRecordCorrectionRawPage> {
    return this.request(LANDING_URL, { method: "GET" }, signal);
  }

  public async years(signal?: AbortSignal): Promise<KboRecordCorrectionRawPage> {
    return this.post(YEAR_CONTROL_URL, new URLSearchParams(), signal);
  }

  public async series(season: number, signal?: AbortSignal): Promise<KboRecordCorrectionRawPage> {
    return this.post(SERIES_CONTROL_URL, new URLSearchParams({ seasonId: String(season) }), signal);
  }

  public async records(
    season: number,
    seriesId: number,
    pageNumber: number,
    signal?: AbortSignal,
  ): Promise<KboRecordCorrectionRawPage> {
    return this.post(
      RECORDS_URL,
      new URLSearchParams({
        pageNo: String(pageNumber),
        listCn: "100",
        seasonId: String(season),
        srId: String(seriesId),
        month: "0",
        team: "",
        beforeRecord: "",
        afterRecord: "",
      }),
      signal,
    );
  }

  private async post(
    url: string,
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<KboRecordCorrectionRawPage> {
    return this.request(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: LANDING_URL,
          "X-Requested-With": "XMLHttpRequest",
          ...(this.cookie === null ? {} : { Cookie: this.cookie }),
        },
        body,
      },
      signal,
    );
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<KboRecordCorrectionRawPage> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (signal !== undefined) throwIfCancelled(signal);
      await this.waitForRateSlot(signal);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      try {
        const response = await this.fetchImplementation(url, { ...init, signal: requestSignal });
        if (!response.ok) throw new Error(`KBO HTTP ${String(response.status)}: ${url}`);
        const cookies = response.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0]?.trim())
          .filter((value): value is string => value !== undefined && value.length > 0);
        if (cookies.length > 0) this.cookie = cookies.join("; ");
        return {
          body: (await response.text()).replace(/^\uFEFF/, ""),
          collectedAt: new Date(this.now()).toISOString(),
        };
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error;
        lastError = error;
        if (attempt < this.maxAttempts) await abortableDelay(250 * 2 ** (attempt - 1), signal);
      }
    }
    throw lastError;
  }

  private async waitForRateSlot(signal?: AbortSignal): Promise<void> {
    const previous = this.rateGate;
    let release: (() => void) | undefined;
    this.rateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal !== undefined) throwIfCancelled(signal);
      const waitMs = Math.max(0, this.nextRequestAt - this.now());
      if (waitMs > 0) await abortableDelay(waitMs, signal);
      this.nextRequestAt = this.now() + this.minimumIntervalMs;
    } finally {
      release?.();
    }
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("KBO 수집 취소"));
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
