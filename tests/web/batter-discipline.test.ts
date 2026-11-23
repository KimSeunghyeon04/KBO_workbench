// @vitest-environment jsdom
import { DisciplineQuerySchema, resolveAnalysisScope } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeBatterDiscipline, prepareDisciplineSeason } from "@kbo/game-core";
import { BatterDisciplinePage } from "../../apps/web/src/pages/batter-discipline-page.js";
import { PlayerAnalysisFrame } from "../../apps/web/src/analysis/player-analysis-frame.js";
import {
  getBatterDiscipline,
  validateDisciplineResponse,
} from "../../apps/web/src/api/batter-discipline-client.js";
import { disciplineRow, disciplineSnapshot } from "../helpers/batter-discipline.js";
import type { DisciplineQuery, PlayerDirectoryEntry } from "@kbo/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const response = (query: DisciplineQuery = { season: 2024 }, batter = "b1") =>
  analyzeBatterDiscipline(
    prepareDisciplineSeason({
      ...disciplineSnapshot([disciplineRow({ batterId: batter })]),
      season: query.season,
    }),
    batter,
    query,
  );
function Location() {
  return createElement("output", { "aria-label": "현재 주소" }, useLocation().search);
}
function show(
  url = "/analysis/batter-discipline?season=2024",
  directory: PlayerDirectoryEntry[] = [],
) {
  render(
    createElement(
      QueryClientProvider,
      { client: createAnalysisQueryClient(directory) },
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(PlayerAnalysisFrame, null, createElement(BatterDisciplinePage)),
        createElement(Location),
      ),
    ),
  );
}
describe("batter discipline view", () => {
  it.each([false, true])(
    "keeps the same batter across seasons and shows a missing-player state (explicit=%s)",
    async (explicit) => {
      const fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        const raw = Object.fromEntries(url.searchParams);
        const query = Value.Decode(DisciplineQuerySchema, { ...raw, season: Number(raw.season) });
        if (url.pathname.endsWith("batter-discipline"))
          return Response.json({
            season: query.season,
            scope: resolveAnalysisScope(query),
            batters: (query.season === 2024
              ? ["b1"]
              : query.season === 2025
                ? ["b2", "b1"]
                : ["b2"]
            ).map((batterId) => ({ batterId, name: batterId, pitches: 1 })),
          });
        return Response.json(response(query, url.pathname.endsWith("b1") ? "b1" : "b2"));
      });
      vi.stubGlobal("fetch", fetch);
      show(
        `/analysis/batter-discipline?season=2024&dateFrom=2024-06-01&dateTo=2024-06-30${explicit ? "&batter=b1" : ""}`,
      );
      await screen.findByLabelText("코스별 스윙 지도");
      fireEvent.change(screen.getByLabelText("분석 시즌"), { target: { value: "2025" } });
      await screen.findByLabelText("코스별 스윙 지도");
      expect(screen.getByText("b1", { exact: true })).toBeTruthy();
      let current = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
      expect(Object.fromEntries(current)).toEqual({ season: "2025", batter: "b1" });
      fireEvent.change(screen.getByLabelText("분석 시즌"), { target: { value: "2023" } });
      await screen.findByText("선택한 타자(ID b1)의 실제 투구가 이 조회 범위에 없습니다.");
      expect(screen.getByText("b1", { exact: true })).toBeTruthy();
      expect(screen.queryByLabelText("코스별 스윙 지도")).toBeNull();
      current = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
      expect(current.get("batter")).toBe("b1");
      expect(
        fetch.mock.calls.some(([input]) =>
          new URL(String(input), "http://localhost").pathname.endsWith("/b2"),
        ),
      ).toBe(false);
    },
  );

  it("keeps all restored situation conditions visible while collapsed without refetching on disclosure", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const raw = Object.fromEntries(url.searchParams);
      const query = Value.Decode(DisciplineQuerySchema, {
        ...raw,
        season: Number(raw.season),
        ...(raw.balls === undefined ? {} : { balls: Number(raw.balls) }),
        ...(raw.strikes === undefined ? {} : { strikes: Number(raw.strikes) }),
      });
      if (url.pathname.endsWith("batter-discipline"))
        return Response.json({
          season: query.season,
          scope: resolveAnalysisScope(query),
          batters: [{ batterId: "b1", name: "타자", pitches: 1 }],
        });
      return Response.json(response(query));
    });
    vi.stubGlobal("fetch", fetch);
    show(
      "/analysis/batter-discipline?season=2024&competition=regular&batter=b1&dateFrom=2024-06-01&dateTo=2024-06-30&balls=0&strikes=2&pitchType=직구&stance=R&leaguePeriod=target",
    );
    await screen.findByLabelText("코스별 스윙 지도");
    expect(screen.getByLabelText("선구안 카운트")).toHaveProperty("value", "0-2");
    expect(screen.getByLabelText("선구안 구종")).toHaveProperty("value", "직구");
    expect(screen.getByLabelText("선구안 타석")).toHaveProperty("value", "R");
    const trigger = screen.getByText("조회 조건 변경");
    const details = trigger.closest("details");
    if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing condition disclosure");
    expect(details.open).toBe(false);
    for (const condition of [
      "0볼",
      "2스트라이크",
      "구종: 직구",
      "우타석",
      "리그 비교: 대상과 같은 기간",
    ]) {
      expect(details.querySelector("summary")?.textContent).toContain(condition);
    }
    const requests = fetch.mock.calls.length;
    const search = screen.getByLabelText("현재 주소").textContent;
    fireEvent.click(trigger);
    expect(details.open).toBe(true);
    fireEvent.click(trigger);
    expect(details.open).toBe(false);
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledTimes(requests);
    expect(screen.getByLabelText("현재 주소").textContent).toBe(search);
    expect(
      fetch.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return (
          url.pathname.endsWith("/b1") &&
          url.searchParams.get("balls") === "0" &&
          url.searchParams.get("strikes") === "2" &&
          url.searchParams.get("pitchType") === "직구" &&
          url.searchParams.get("stance") === "R"
        );
      }),
    ).toBe(true);
  });

  it("loads defaults, selects a map cell and pitch, restores filters in URL, and resets", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("batter-discipline"))
        return new Response(
          JSON.stringify({
            season: 2024,
            scope: resolveAnalysisScope({ season: 2024 }),
            batters: [{ batterId: "b1", name: "타자 A", pitches: 1 }],
          }),
        );
      const query: DisciplineQuery = {
        season: 2024,
        ...(url.searchParams.has("dateFrom")
          ? { dateFrom: url.searchParams.get("dateFrom") ?? "" }
          : {}),
        ...(url.searchParams.has("dateTo") ? { dateTo: url.searchParams.get("dateTo") ?? "" } : {}),
        ...(url.searchParams.has("balls") ? { balls: Number(url.searchParams.get("balls")) } : {}),
        ...(url.searchParams.has("strikes")
          ? { strikes: Number(url.searchParams.get("strikes")) }
          : {}),
      };
      return new Response(JSON.stringify(response(query)));
    });
    vi.stubGlobal("fetch", fetch);
    show();
    await screen.findByLabelText("코스별 스윙 지도");
    expect(screen.getByRole("table", { name: "기존 코스 기본 지표 · 조건 보정 전" })).toBeTruthy();
    expect(
      screen.getByRole("table", { name: "동일 표본의 리그 비교 · 포심 조건 추가 전후" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "코스 13: 스윙 0 / 1구" }));
    fireEvent.click(screen.getByRole("button", { name: /2024-06-01 · 직구/ }));
    expect(screen.getByLabelText("선택한 투구 상세")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("선구안 카운트"), { target: { value: "1-2" } });
    await screen.findByText("선택 조건에서 코스를 계산할 수 있는 투구가 없습니다.");
    expect(screen.getByLabelText("현재 주소").textContent).toContain("balls=1&strikes=2");
    fireEvent.click(screen.getByRole("button", { name: "조건 초기화" }));
    await screen.findByRole("button", { name: "코스 13: 스윙 0 / 1구" });
    const beforeComparison = fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "기간 비교 열기" }));
    fireEvent.change(screen.getByLabelText("기간 B 시작일"), { target: { value: "2024-07-01" } });
    fireEvent.change(screen.getByLabelText("기간 B 종료일"), { target: { value: "2024-07-31" } });
    expect(screen.getByLabelText<HTMLInputElement>("기간 B 시작일").value).toBe("2024-07-01");
    expect(fetch).toHaveBeenCalledTimes(beforeComparison);
    expect(screen.queryByLabelText("선택한 투구 상세")).toBeNull();
    fireEvent.change(screen.getByLabelText("선구안 카운트"), { target: { value: "*-2" } });
    await screen.findByText("선택 조건에서 코스를 계산할 수 있는 투구가 없습니다.");
    expect(screen.getByLabelText("현재 주소").textContent).toContain("strikes=2");
    expect(screen.getByLabelText("현재 주소").textContent).not.toContain("balls=");
  });
  it("discards reversed responses after a batter change without showing the old result", async () => {
    let first: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname.endsWith("batter-discipline"))
          return new Response(
            JSON.stringify({
              season: 2024,
              scope: resolveAnalysisScope({ season: 2024 }),
              batters: ["b1", "b2"].map((batterId) => ({ batterId, name: batterId, pitches: 1 })),
            }),
          );
        if (url.pathname.endsWith("b1"))
          return new Promise<Response>((resolve) => {
            first = resolve;
          });
        return new Response(JSON.stringify(response({ season: 2024 }, "b2")));
      }),
    );
    show(undefined, [
      {
        identity: "naver:b2",
        sourceIds: ["b2"],
        name: "b2",
        primaryPosition: null,
        teams: ["가상 팀"],
        seasons: [{ season: 2024, battingPlayerId: "b2", pitchingPlayerId: null }],
      },
    ]);
    await waitFor(() => expect(first).toBeDefined());
    fireEvent.change(screen.getByRole("searchbox", { name: "선수 검색" }), {
      target: { value: "b2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^b2, 출생연도 미확인, 포지션 미확인/ }));
    await screen.findByLabelText("코스별 스윙 지도");
    await act(async () => {
      first?.(new Response(JSON.stringify(response())));
    });
    expect(screen.getByText("b2", { exact: true })).toBeTruthy();
    expect(screen.getByText("b2 · 선택 조건")).toBeTruthy();
  });
  it("rejects response/target mismatches, invalid denominators and absent strict fields", async () => {
    const data = response();
    validateDisciplineResponse(data);
    const invalidCourse = structuredClone(data);
    invalidCourse.courseComparison.conventional.batter.chaseRate = 0.5;
    expect(() => validateDisciplineResponse(invalidCourse)).toThrow("집계");
    const invalidPair = structuredClone(data);
    const firstPair = invalidPair.courseComparison.paired[0];
    if (firstPair === undefined) throw new Error("Missing paired comparison");
    firstPair.courseLeagueSwingRate = 0.5;
    expect(() => validateDisciplineResponse(invalidPair)).toThrow("집계");
    expect(() =>
      validateDisciplineResponse({ ...data, coverage: { ...data.coverage, locationPitches: 2 } }),
    ).toThrow("집계");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(data))),
    );
    await expect(
      getBatterDiscipline({ season: 2025 }, "b1", new AbortController().signal),
    ).rejects.toThrow("대상");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...data, transitions: undefined }))),
    );
    await expect(
      getBatterDiscipline({ season: 2024 }, "b1", new AbortController().signal),
    ).rejects.toThrow();
  });
});
