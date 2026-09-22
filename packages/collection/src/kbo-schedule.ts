import { createHash } from "node:crypto";
import { load } from "cheerio";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  parseGameCompetitionDataset,
  type GameCompetition,
  type CompetitionEntry,
  type GameCompetitionDataset,
} from "@kbo/contracts";
import {
  RetryingHttpTransport,
  readBoundedResponseText,
  responseCookies,
  HttpStatusError,
  type RetryingHttpTransportOptions,
} from "./http-transport.js";

const pageUrl = "https://www.koreabaseball.com/Schedule/Schedule.aspx";
const apiUrl = "https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList";
const series = { preseason: "1", regular: "0,9,6", postseason: "3,4,5,7" } as const;
const responseSchema = Type.Object(
  {
    rows: Type.Array(
      Type.Object(
        {
          row: Type.Array(
            Type.Object(
              { Text: Type.Union([Type.String(), Type.Null()]) },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

export function parseKboCompetitionPage(
  body: string,
  season: number,
  month: number,
  competition: GameCompetition,
): CompetitionEntry[] {
  // Provider containers carry presentation attributes. Decode the fields used, then emit a strict contract.
  const decoded = Value.Decode(responseSchema, JSON.parse(body.replace(/^\uFEFF/u, "")));
  const pageHash = createHash("sha256").update(body).digest("hex");
  const entries = new Map<string, CompetitionEntry>();
  for (const row of decoded.rows) {
    for (const cell of row.row) {
      const $ = load(cell.Text ?? "");
      for (const element of $("a[href]").toArray()) {
        const href = $(element).attr("href");
        if (href === undefined) continue;
        const url = new URL(href, pageUrl);
        const id = url.searchParams.get("gameId"),
          date = url.searchParams.get("gameDate");
        if (id === null && date === null) continue;
        if (url.origin !== new URL(pageUrl).origin)
          throw new Error("일정 경기 링크의 출처가 다릅니다.");
        if (id === null || date === null || !/^\d{8}$/u.test(date))
          throw new Error("일정 경기 식별자가 불완전합니다.");
        const gameDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
        if (Number(date.slice(0, 4)) !== season || Number(date.slice(4, 6)) !== month)
          throw new Error("요청한 시즌·월과 일정 응답이 다릅니다.");
        const known = entries.get(id);
        if (known !== undefined && known.gameDate !== gameDate)
          throw new Error("동일 경기 ID의 날짜가 충돌합니다.");
        entries.set(id, { sourceGameId: id, gameDate, competition, pageHash });
      }
    }
  }
  return [...entries.values()].sort((a, b) =>
    a.sourceGameId < b.sourceGameId ? -1 : a.sourceGameId > b.sourceGameId ? 1 : 0,
  );
}

type Sink = (page: {
  month: number;
  competition: GameCompetition;
  body: string;
  collectedAt: string;
}) => Promise<{ artifactKey: string; contentHash: string }>;
export class KboScheduleCollector {
  private readonly transport: RetryingHttpTransport;
  public constructor(options: RetryingHttpTransportOptions = {}) {
    this.transport = new RetryingHttpTransport(options);
  }
  public async collect(
    season: number,
    sink: Sink,
    signal?: AbortSignal,
  ): Promise<GameCompetitionDataset> {
    if (!Number.isInteger(season) || season < 1982 || season > 2200)
      throw new Error("잘못된 시즌입니다.");
    const request = async (url: string, init: RequestInit) =>
      this.transport.request({
        url,
        init,
        ...(signal === undefined ? {} : { signal }),
        retryable: (error) =>
          !(error instanceof HttpStatusError) || error.status === 429 || error.status >= 500,
        decode: async (response) => ({
          body: await readBoundedResponseText(
            response,
            8 * 1024 * 1024,
            () => new Error("일정 응답 크기 초과"),
          ),
          cookie: responseCookies(response.headers),
        }),
      });
    const initial = await request(pageUrl, { method: "GET" });
    const pages: GameCompetitionDataset["pages"] = [],
      entries: CompetitionEntry[] = [];
    for (let month = 1; month <= 12; month++)
      for (const competition of ["preseason", "regular", "postseason"] as const) {
        signal?.throwIfAborted();
        const response = await request(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Referer: pageUrl,
            "X-Requested-With": "XMLHttpRequest",
            ...(initial.value.cookie === null ? {} : { Cookie: initial.value.cookie }),
          },
          body: new URLSearchParams({
            leId: "1",
            srIdList: series[competition],
            seasonId: String(season),
            gameMonth: String(month).padStart(2, "0"),
            teamId: "",
          }),
        });
        const parsed = parseKboCompetitionPage(response.value.body, season, month, competition);
        const artifact = await sink({
          month,
          competition,
          body: response.value.body,
          collectedAt: response.receivedAt,
        });
        if (artifact.contentHash !== createHash("sha256").update(response.value.body).digest("hex"))
          throw new Error("저장한 일정 원문 해시가 다릅니다.");
        pages.push({
          month,
          competition,
          sourceUrl: apiUrl,
          ...artifact,
          collectedAt: response.receivedAt,
        });
        entries.push(...parsed);
      }
    return parseGameCompetitionDataset({ version: 1, season, pages, entries });
  }
}
