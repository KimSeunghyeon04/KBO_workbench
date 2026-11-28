// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { summarizePlayerSplits } from "@kbo/game-core";
import { PlayerSplitsPage } from "../../apps/web/src/pages/player-splits-page.js";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "loads a count link from one detail response and recovers the summary on failure (%s)",
  async (failDetail) => {
    const rows = summarizePlayerSplits(
      ["L", "R", "unknown"],
      [
        { bucket: "L", result: "single", countsAsAtBat: true },
        { bucket: "unknown", result: "strikeout", countsAsAtBat: true },
      ],
    );
    const requests = vi.fn(async (input: string) => {
      const params = new URL(input, "http://localhost").searchParams;
      const detail = params.has("countFor");
      if (detail && failDetail) return new Response("unavailable", { status: 500 });
      const first = rows[0];
      if (first === undefined) throw new Error("Missing split fixture");
      const { bucket, ...stats } = first;
      expect(bucket).toBe("L");
      return Response.json({
        query: { ...Object.fromEntries(params), season: 2025 },
        scope: { season: 2025, competition: "regular", dateFrom: null, dateTo: null },
        rows,
        ...(detail ? { byCount: [{ ...stats, count: { balls: 2, strikes: 1 } }] } : {}),
      });
    });
    vi.stubGlobal("fetch", requests);
    const client = createAnalysisQueryClient();
    client.setQueryDefaults(["player-split-records"], { staleTime: 2_000 });
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          {
            initialEntries: [
              "/analysis/player-splits?season=2025&player=kbo%3A123&playerRole=batter&countFor=L",
            ],
          },
          createElement(PlayerSplitsPage),
        ),
      ),
    );
    const summary = within(await screen.findByRole("table", { name: "상황별 타격 성적" }));
    expect(summary.getAllByRole("rowheader").map((row) => row.textContent)).toEqual([
      "좌완 상대",
      "우완 상대",
      "상대 손 미확인",
    ]);
    const buckets = () =>
      requests.mock.calls.map(([input]) =>
        new URL(input, "http://localhost").searchParams.get("countFor"),
      );
    if (failDetail) {
      expect(buckets()).toEqual(["L", null]);
      expect(screen.queryByRole("rowheader", { name: "2-1" })).toBeNull();
    } else {
      expect(await screen.findByRole("rowheader", { name: "2-1" })).toBeTruthy();
      expect(buckets()).toEqual(["L"]);
      fireEvent.change(screen.getByRole("combobox", { name: "카운트별로 볼 상황" }), {
        target: { value: "" },
      });
      expect(summary.getByRole("rowheader", { name: "좌완 상대" })).toBeTruthy();
      expect(buckets()).toEqual(["L"]);
    }
  },
);

it("shows the unknown-hand sample and preserves selection scope when switching to home and away", async () => {
  const scope = { season: 2025, competition: "regular", dateFrom: "2025-04-01", dateTo: null };
  const request = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const query = { ...Object.fromEntries(url.searchParams), season: 2025 };
    const rows =
      url.searchParams.get("split") === "venue"
        ? summarizePlayerSplits(
            ["home", "away"],
            [
              { bucket: "home", result: "single", countsAsAtBat: true },
              { bucket: "away", result: "strikeout", countsAsAtBat: true },
            ],
          )
        : summarizePlayerSplits(
            ["L", "R", "unknown"],
            [
              { bucket: "L", result: "single", countsAsAtBat: true },
              { bucket: "unknown", result: "strikeout", countsAsAtBat: true },
            ],
          );
    const byCount =
      url.searchParams.get("countFor") === "L"
        ? rows
            .filter((row) => row.bucket === "L")
            .map(({ bucket, ...row }) => {
              void bucket;
              return { ...row, count: { balls: 2, strikes: 1 } };
            })
        : undefined;
    return Response.json({ query, scope, rows, byCount });
  });
  vi.stubGlobal("fetch", request);
  render(
    createElement(
      QueryClientProvider,
      { client: createAnalysisQueryClient() },
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/player-splits?season=2025&dateFrom=2025-04-01&player=kbo%3A123&playerRole=batter",
          ],
        },
        createElement(PlayerSplitsPage),
      ),
    ),
  );
  const table = within(await screen.findByRole("table", { name: "상황별 타격 성적" }));
  expect(table.getAllByRole("rowheader").map((row) => row.textContent)).toEqual([
    "좌완 상대",
    "우완 상대",
    "상대 손 미확인",
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("combobox", { name: "카운트별로 볼 상황" }), {
    target: { value: "L" },
  });
  const counts = within(await screen.findByRole("table", { name: "선택 상황의 카운트별 성적" }));
  expect(counts.getByRole("rowheader", { name: "2-1" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "비교 기준" }), {
    target: { value: "venue" },
  });
  await screen.findByRole("rowheader", { name: "원정" });
  expect(screen.queryByRole("table", { name: "선택 상황의 카운트별 성적" })).toBeNull();
  expect(
    request.mock.calls.map(([input]) =>
      Object.fromEntries(new URL(input, "http://localhost").searchParams),
    ),
  ).toEqual(
    [{ split: "hand" }, { split: "hand", countFor: "L" }, { split: "venue" }].map((filter) => ({
      season: "2025",
      competition: "regular",
      dateFrom: "2025-04-01",
      player: "kbo:123",
      role: "batter",
      ...filter,
    })),
  );
});
