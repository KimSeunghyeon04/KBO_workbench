import { load } from "cheerio";

import { throwIfCancelled } from "../errors.js";

const REGISTER_URL = "https://www.koreabaseball.com/Player/Register.aspx";
const TRADE_PAGE_URL = "https://www.koreabaseball.com/Player/Trade.aspx";
const TRADE_API_URL = "https://www.koreabaseball.com/ws/Player.asmx/GetTradeList";
const EVENT_TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const TEAM_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const DATE_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";

export interface KboRegistryHttpOptions {
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly requestsPerSecond?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface KboRegistryRawPage {
  readonly body: string;
  readonly collectedAt: string;
}

export class KboRegistryHttpClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private nextRequestAt = 0;
  private rateGate: Promise<void> = Promise.resolve();

  public constructor(options: KboRegistryHttpOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.minimumIntervalMs = 1_000 / (options.requestsPerSecond ?? 2);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  public async registerPage(
    date: string,
    teamCode: string,
    signal?: AbortSignal,
  ): Promise<KboRegistryRawPage> {
    const initial = await this.request(REGISTER_URL, { method: "GET" }, signal);
    const hidden = hiddenFields(initial.body);
    const body = new URLSearchParams({
      ...hidden,
      __EVENTTARGET: EVENT_TARGET,
      __EVENTARGUMENT: "",
      [TEAM_FIELD]: teamCode,
      [DATE_FIELD]: date.replaceAll("-", ""),
      [EVENT_TARGET]: "",
    });
    return this.request(
      REGISTER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: REGISTER_URL,
          ...(initial.cookie === null ? {} : { Cookie: initial.cookie }),
        },
        body,
      },
      signal,
    );
  }

  public async tradePage(
    season: number,
    month: number,
    page: number,
    listCount: number,
    signal?: AbortSignal,
  ): Promise<KboRegistryRawPage> {
    const initial = await this.request(TRADE_PAGE_URL, { method: "GET" }, signal);
    return this.request(
      TRADE_API_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: TRADE_PAGE_URL,
          "X-Requested-With": "XMLHttpRequest",
          ...(initial.cookie === null ? {} : { Cookie: initial.cookie }),
        },
        body: new URLSearchParams({
          seasonId: String(season),
          monthId: String(month),
          bdSc: "0",
          teamName: "",
          searchIf: "",
          pageNo: String(page),
          listCount: String(listCount),
        }),
      },
      signal,
    );
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<KboRegistryRawPage & { readonly cookie: string | null }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (signal !== undefined) throwIfCancelled(signal);
      await this.waitForRateSlot(signal);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      try {
        const response = await this.fetchImplementation(url, { ...init, signal: requestSignal });
        if (!response.ok) throw new Error(`KBO HTTP ${String(response.status)}: ${url}`);
        const body = (await response.text()).replace(/^\uFEFF/, "");
        return {
          body,
          collectedAt: new Date(this.now()).toISOString(),
          cookie: responseCookies(response.headers),
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

function responseCookies(headers: Headers): string | null {
  const values = headers.getSetCookie();
  const cookies = values
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((value): value is string => value !== undefined && value.length > 0);
  return cookies.length === 0 ? null : cookies.join("; ");
}

function hiddenFields(html: string): Record<string, string> {
  const $ = load(html);
  const result: Record<string, string> = {};
  for (const name of ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]) {
    const value = $(`input[name='${name}']`).attr("value");
    if (value === undefined) throw new Error(`KBO Register hidden field가 없습니다: ${name}`);
    result[name] = value;
  }
  return result;
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
