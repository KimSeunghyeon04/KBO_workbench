import { createHash } from "node:crypto";
import { load } from "cheerio";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  parseGameCompetitionDataset,
  isCalendarDate,
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
import { linkKboCompetitionGames } from "./kbo-game-links.js";
import { kboTiebreakEvidence } from "./kbo-tiebreak-evidence.js";

const pageUrl = "https://www.koreabaseball.com/Schedule/Schedule.aspx";
const apiUrl = "https://www.koreabaseball.com/ws/Schedule.asmx/GetScheduleList";
const gameCenterUrl = "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx";
const gameListUrl = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList";
const series = [
  ["preseason", "1"],
  ["regular", "0,9,6"],
  ["postseason", "3,4,5,7"],
] as const;
const gameListSchema = Type.Object({
  code: Type.Literal("100"),
  game: Type.Array(
    Type.Object({
      G_ID: Type.String(),
      G_DT: Type.String(),
      SEASON_ID: Type.Integer(),
      SR_ID: Type.Integer(),
      GAME_SC_ID: Type.Integer(),
    }),
  ),
});
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
  day?: number;
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
    games: readonly { sourceGameId: string; gameDate: string }[] = [],
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
      for (const [competition, seriesIds] of series) {
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
            srIdList: seriesIds,
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
    const matchedSources = new Set([
      ...entries.map((row) => row.sourceGameId),
      ...linkKboCompetitionGames({ entries }, games).map((link) => link.matchedSourceGameId),
    ]);
    const dates = new Set(
      games.filter((game) => !matchedSources.has(game.sourceGameId)).map((game) => game.gameDate),
    );
    const tiebreaks = kboTiebreakEvidence.filter((row) => row.gameDate.startsWith(`${season}-`));
    for (const row of tiebreaks) dates.add(row.gameDate);
    const supplemental = new Map<string, CompetitionEntry>();
    for (const date of [...dates].sort()) {
      signal?.throwIfAborted();
      if (!isCalendarDate(date) || !date.startsWith(`${season}-`))
        throw new Error("일별 일정 조회의 날짜가 올바르지 않습니다.");
      const providerDate = date.replaceAll("-", "");
      const response = await request(gameListUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: gameCenterUrl,
          "X-Requested-With": "XMLHttpRequest",
          ...(initial.value.cookie === null ? {} : { Cookie: initial.value.cookie }),
        },
        body: new URLSearchParams({ leId: "1", srId: "6,9", date: providerDate }),
      });
      const { body } = response.value;
      const { game: rows } = Value.Decode(gameListSchema, JSON.parse(body.replace(/^\uFEFF/u, "")));
      const expectedTiebreaks = tiebreaks.filter((row) => row.gameDate === date);
      if (rows.some((row) => row.G_DT !== providerDate || row.SEASON_ID !== season))
        throw new Error("요청한 시즌·날짜와 일별 일정 응답이 다릅니다.");
      for (const expected of expectedTiebreaks) {
        if (!rows.some((row) => row.G_ID === expected.sourceGameId))
          throw new Error(
            `순위 결정전의 공식 경기 ID를 확인할 수 없습니다: ${expected.sourceGameId} (${expected.noticeUrl})`,
          );
      }
      const pageHash = createHash("sha256").update(body).digest("hex");
      for (const [competition, ids] of [
        [
          "allstar",
          rows.filter((row) => row.SR_ID === 9 && row.GAME_SC_ID === 5).map((row) => row.G_ID),
        ],
        ["postseason", expectedTiebreaks.map((row) => row.sourceGameId)],
      ] as const) {
        if (ids.length === 0) continue;
        const month = Number(date.slice(5, 7)),
          day = Number(date.slice(8, 10));
        const collectedAt = response.receivedAt;
        const artifact = await sink({ month, day, competition, body, collectedAt });
        if (artifact.contentHash !== pageHash) throw new Error("저장한 일정 원문 해시가 다릅니다.");
        pages.push({ month, day, competition, sourceUrl: gameListUrl, ...artifact, collectedAt });
        for (const sourceGameId of ids) {
          if (supplemental.has(sourceGameId))
            throw new Error(`일별 일정의 경기 ID가 중복됩니다: ${sourceGameId}`);
          supplemental.set(sourceGameId, { sourceGameId, gameDate: date, competition, pageHash });
        }
      }
    }
    return parseGameCompetitionDataset({
      version: supplemental.size === 0 ? 1 : 2,
      season,
      pages,
      entries: [
        ...entries.filter((row) => !supplemental.has(row.sourceGameId)),
        ...supplemental.values(),
      ],
    });
  }
}
