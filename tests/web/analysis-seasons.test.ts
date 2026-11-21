// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { App } from "../../apps/web/src/app.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(url = "/analysis/players", options: { stale?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  if (options.stale)
    client.setQueryData(
      ["analysis-seasons"],
      { sourceHash: "b".repeat(64), seasons: [2025], preparation: [] },
      { updatedAt: Date.now() - 60_000 },
    );
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [url] }, createElement(App)),
    ),
  );
  return client;
}

it.each([false, true])("waits for the latest season on entry (stale cache: %s)", async (stale) => {
  const seasons = Promise.withResolvers<Response>();
  const requestedSeasons: (string | null)[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/analysis/seasons")) return seasons.promise;
    if (url.pathname !== "/api/v2/analysis/pitch-shape") throw new Error(url.pathname);
    const season = url.searchParams.get("season");
    requestedSeasons.push(season);
    return Promise.resolve(
      Response.json({
        season: Number(season),
        scope: resolveAnalysisScope({ season: Number(season), competition: "regular" }),
        pitchers: [{ pitcherId: "anonymous", name: "가상 투수", pitches: 100 }],
      }),
    );
  });

  show(undefined, { stale });
  await screen.findByText("적재 시즌을 확인하고 있습니다.");
  expect(requestedSeasons).toEqual([]);
  await act(async () => {
    seasons.resolve(
      Response.json({ sourceHash: "a".repeat(64), seasons: [2026, 2025], preparation: [] }),
    );
  });
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  expect(screen.getByRole("option", { name: "2026", selected: true })).toBeTruthy();
  expect(requestedSeasons).toEqual(["2026"]);
});

it("allows retrying the season list and shows the empty state without starting analysis", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(null, { status: 400 }))
    .mockResolvedValueOnce(
      Response.json({ sourceHash: "a".repeat(64), seasons: [], preparation: [] }),
    );
  vi.stubGlobal("fetch", fetch);
  show("/analysis/models");
  await screen.findByText(/적재 시즌과 자동 반영 상태를 확인하지 못했습니다/u);
  fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
  await screen.findByRole("heading", { name: "적재된 시즌이 없습니다" });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/v2/analysis/seasons",
    "/api/v2/analysis/seasons",
  ]);
});

it("keeps a completed analysis when the first season status arrives", async () => {
  const seasons = Promise.withResolvers<Response>();
  const catalog = vi.fn(() =>
    Response.json({
      season: 2025,
      scope: resolveAnalysisScope({ season: 2025, competition: "regular" }),
      pitchers: [{ pitcherId: "anonymous", name: "가상 투수", pitches: 100 }],
    }),
  );
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    String(input).includes("/analysis/seasons") ? seasons.promise : Promise.resolve(catalog()),
  );
  show("/analysis/players?season=2025");
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  await act(async () => {
    seasons.resolve(
      Response.json({ sourceHash: "a".repeat(64), seasons: [2025, 2024], preparation: [] }),
    );
  });
  await screen.findByRole("option", { name: "2024" });
  expect(catalog).toHaveBeenCalledTimes(1);
});

it("rechecks a stale season list when navigating from an explicit season to a seasonless page", async () => {
  const seasons = Promise.withResolvers<Response>();
  const modelSeasons: (string | null)[] = [];
  let checkAgain = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v2/analysis/seasons") {
      return checkAgain
        ? seasons.promise
        : Promise.resolve(
            Response.json({ sourceHash: "a".repeat(64), seasons: [2025, 2024], preparation: [] }),
          );
    }
    if (url.pathname === "/api/v2/analysis/pitch-shape") {
      return Promise.resolve(
        Response.json({
          season: 2025,
          scope: resolveAnalysisScope({ season: 2025, competition: "regular" }),
          pitchers: [{ pitcherId: "anonymous", name: "가상 투수", pitches: 100 }],
        }),
      );
    }
    if (url.pathname === "/api/v2/analysis/models") {
      modelSeasons.push(url.searchParams.get("season"));
      return Promise.resolve(Response.json(null, { status: 400 }));
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });

  show("/analysis/players?season=2025");
  await screen.findByRole("option", { name: "2024" });
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  const now = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => now() + 30_000);
  checkAgain = true;
  fireEvent.click(screen.getByRole("link", { name: "분석 모델 관리" }));
  await screen.findByText("적재 시즌을 확인하고 있습니다.");
  expect(modelSeasons).toEqual([]);
  await act(async () => {
    seasons.resolve(
      Response.json({ sourceHash: "a".repeat(64), seasons: [2026, 2025], preparation: [] }),
    );
  });
  await waitFor(() => expect(modelSeasons).toEqual(["2026"]));
});

it("discovers imported seasons, defaults to the latest and refreshes active analysis when a new source arrives", async () => {
  let version = 1;
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/seasons"))
      return Response.json({
        sourceHash: String(version).repeat(64),
        seasons: version === 1 ? [2026, 2024] : [2027, 2026, 2024],
        preparation: [],
      });
    if (url.pathname === "/api/v2/analysis/pitch-shape") {
      calls.push(url.search);
      const season = Number(url.searchParams.get("season"));
      return Response.json({
        season,
        scope: resolveAnalysisScope({ season, competition: "regular" }),
        pitchers: [{ pitcherId: "anonymous", name: "가상 투수", pitches: version * 100 }],
      });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  const client = show();
  await screen.findByRole("option", { name: "2026", selected: true });
  expect(await screen.findByRole("option", { name: "2024" })).toBeTruthy();
  await screen.findByRole("link", { name: "가상 투수 분석 보기" });
  version = 2;
  await client.invalidateQueries({ queryKey: ["analysis-seasons"] });
  await screen.findByRole("option", { name: "2027" });
  await waitFor(() => expect(calls.some((call) => call.includes("season=2027"))).toBe(true));
  fireEvent.change(screen.getByRole("combobox", { name: "선수 분석 시즌" }), {
    target: { value: "2026" },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "가상 투수 분석 보기" }).getAttribute("href"),
    ).toContain("season=2026"),
  );
  const prior = calls.length;
  version = 3;
  await client.invalidateQueries({ queryKey: ["analysis-seasons"] });
  await waitFor(() => expect(calls.length).toBeGreaterThan(prior));
  expect(screen.getByRole("link", { name: "가상 투수 분석 보기" }).getAttribute("href")).toContain(
    "season=2026",
  );
});
