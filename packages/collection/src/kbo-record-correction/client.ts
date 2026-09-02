import {
  HttpStatusError,
  readBoundedResponseText,
  responseCookies,
  RetryingHttpTransport,
  type RetryingHttpTransportOptions,
} from "../http-transport.js";

const LANDING_URL = "https://www.koreabaseball.com/Record/RecordCorrect/RecordCorrect.aspx";
const YEAR_CONTROL_URL = "https://www.koreabaseball.com/ws/Controls.asmx/GetRecordCorrectYear";
const SERIES_CONTROL_URL = "https://www.koreabaseball.com/ws/Controls.asmx/GetRecordCorrectSeries";
const RECORDS_URL = "https://www.koreabaseball.com/ws/Record.asmx/GetRecordCorrectList";

export interface KboRecordCorrectionHttpOptions extends RetryingHttpTransportOptions {
  readonly maxResponseBytes?: number;
}

export interface KboRecordCorrectionRawPage {
  readonly body: string;
  readonly collectedAt: string;
}

export class KboRecordCorrectionHttpClient {
  private readonly transport: RetryingHttpTransport;
  private readonly maxResponseBytes: number;
  private cookie: string | null = null;

  public constructor(options: KboRecordCorrectionHttpOptions = {}) {
    this.transport = new RetryingHttpTransport(options);
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 10 * 1024 * 1024,
      "maxResponseBytes",
    );
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
    assertKboRecordCorrectionUrl(url);
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
          () => new Error("KBO 기록정정 응답 크기가 안전 제한을 초과했습니다."),
        ),
        cookie: responseCookies(response.headers),
      }),
    });
    if (result.value.cookie !== null) this.cookie = result.value.cookie;
    return { body: result.value.body, collectedAt: result.receivedAt };
  }
}

function assertKboRecordCorrectionUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.koreabaseball.com") {
    throw new Error("허용되지 않은 KBO 기록정정 endpoint입니다.");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}은 양의 정수여야 합니다.`);
  return value;
}
