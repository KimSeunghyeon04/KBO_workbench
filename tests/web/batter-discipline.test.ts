// @vitest-environment jsdom
import { resolveAnalysisScope } from "@kbo/contracts";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeBatterDiscipline, prepareDisciplineSeason } from "@kbo/game-core";
import { BatterDisciplinePage } from "../../apps/web/src/pages/batter-discipline-page.js";
import {
  getBatterDiscipline,
  validateDisciplineResponse,
} from "../../apps/web/src/api/batter-discipline-client.js";
import { disciplineRow, disciplineSnapshot } from "../helpers/batter-discipline.js";
import type { DisciplineQuery } from "@kbo/contracts";

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
function show(url = "/analysis/batter-discipline?season=2024") {
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(BatterDisciplinePage),
        createElement(Location),
      ),
    ),
  );
}
describe("batter discipline view", () => {
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
    fireEvent.change(screen.getByLabelText("선구안 비교 시작일"), {
      target: { value: "2024-07-01" },
    });
    fireEvent.change(screen.getByLabelText("선구안 비교 종료일"), {
      target: { value: "2024-07-31" },
    });
    await screen.findByRole("table", { name: "선구안 기간 비교" });
    expect(screen.getByLabelText("현재 주소").textContent).toContain("compareFrom=2024-07-01");
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
    show();
    await waitFor(() => expect(first).toBeDefined());
    fireEvent.change(screen.getByLabelText("분석 타자"), { target: { value: "b2" } });
    await screen.findByLabelText("코스별 스윙 지도");
    await act(async () => {
      first?.(new Response(JSON.stringify(response())));
    });
    expect((screen.getByLabelText("분석 타자") as HTMLSelectElement).value).toBe("b2");
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
