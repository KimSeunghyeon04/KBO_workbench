import { load } from "cheerio";

import {
  HttpStatusError,
  readBoundedResponseText,
  responseCookies,
  RetryingHttpTransport,
  type RetryingHttpTransportOptions,
} from "../http-transport.js";

const REGISTER_URL = "https://www.koreabaseball.com/Player/Register.aspx";
const TRADE_PAGE_URL = "https://www.koreabaseball.com/Player/Trade.aspx";
const TRADE_API_URL = "https://www.koreabaseball.com/ws/Player.asmx/GetTradeList";
const EVENT_TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const TEAM_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const DATE_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";

export interface KboRegistryHttpOptions extends RetryingHttpTransportOptions {
  readonly maxResponseBytes?: number;
}

export interface KboRegistryRawPage {
  readonly body: string;
  readonly collectedAt: string;
}

export class KboRegistryHttpClient {
  private readonly transport: RetryingHttpTransport;
  private readonly maxResponseBytes: number;

  public constructor(options: KboRegistryHttpOptions = {}) {
    this.transport = new RetryingHttpTransport(options);
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 10 * 1024 * 1024,
      "maxResponseBytes",
    );
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
    assertKboUrl(url);
    const result = await this.transport.request({
      url,
      init,
      ...(signal === undefined ? {} : { signal }),
      retryable: (error) =>
        !(error instanceof HttpStatusError) || error.status === 429 || error.status >= 500,
      decode: async (response) => ({
        body: await readBoundedResponseText(
          response,
          this.maxResponseBytes,
          () => new Error("KBO registry 응답 크기가 안전 제한을 초과했습니다."),
        ),
        cookie: responseCookies(response.headers),
      }),
    });
    return { ...result.value, collectedAt: result.receivedAt };
  }
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

function assertKboUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.koreabaseball.com") {
    throw new Error("허용되지 않은 KBO registry endpoint입니다.");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}
