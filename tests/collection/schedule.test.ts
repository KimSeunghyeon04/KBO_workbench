import { describe, expect, it, vi } from "vitest";

import {
  CollectionCancelledError,
  NaverSourceFormatError,
  discoverPages,
  parseSchedulePayload,
} from "@kbo/collection";

import { scheduleGame, schedulePayload } from "../helpers/naver.js";

describe("Naver 일정 탐색", () => {
  it("완료된 KBO 경기만 날짜·시각·ID 순으로 정렬하고 중복 제거한다", async () => {
    const pages = [
      schedulePayload([scheduleGame("G2", "2026-07-02"), scheduleGame("G1", "2026-07-01")], 3),
      schedulePayload([scheduleGame("G1", "2026-07-01")], 3),
    ];
    const fetchPage = vi.fn(async (_start, _end, page: number) => ({
      status: 200,
      url: "https://api-gw.sports.naver.com/schedule/games",
      payload: pages[page - 1],
    }));
    const games = await discoverPages(
      "2026-07-01",
      "2026-07-02",
      new AbortController().signal,
      fetchPage,
    );
    expect(games.map((game) => game.gameId)).toEqual(["G1", "G2"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("취소·진행 중·다른 종목 경기를 결과에서 제외한다", () => {
    const parsed = parseSchedulePayload(
      schedulePayload([
        scheduleGame("OK", "2026-07-01"),
        scheduleGame("CANCEL", "2026-07-01", { cancel: true }),
        scheduleGame("LIVE", "2026-07-01", { statusCode: "LIVE" }),
        scheduleGame("OTHER", "2026-07-01", { categoryId: "mlb" }),
      ]),
      "2026-07-01",
      "2026-07-01",
    );
    expect(parsed.games.map((game) => game.gameId)).toEqual(["OK"]);
    expect(parsed.pageCount).toBe(4);
  });

  it("pagination total 변경과 이미 취소된 signal을 거부한다", async () => {
    let page = 0;
    await expect(
      discoverPages("2026-07-01", "2026-07-01", new AbortController().signal, async () => ({
        status: 200,
        url: "https://api-gw.sports.naver.com/schedule/games",
        payload: schedulePayload(
          [scheduleGame(`G${String(++page)}`, "2026-07-01")],
          page === 1 ? 2 : 3,
        ),
      })),
    ).rejects.toBeInstanceOf(NaverSourceFormatError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverPages("2026-07-01", "2026-07-01", controller.signal, vi.fn()),
    ).rejects.toBeInstanceOf(CollectionCancelledError);
  });
});
