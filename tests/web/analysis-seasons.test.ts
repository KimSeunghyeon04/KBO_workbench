// @vitest-environment jsdom
import { createElement } from "react";
import { focusManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, MemoryRouter, Outlet, Route, Routes, useSearchParams } from "react-router-dom";
import { act, cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope, type AnalysisPreparation } from "@kbo/contracts";
import { modelTrainingPeriod } from "@kbo/game-core";
import { App } from "../../apps/web/src/app.js";
import { analysisCatalogPlayers } from "../../apps/web/src/analysis/player-analysis-navigation.js";
import {
  AnalysisRefreshBoundary,
  AnalysisSeasonOptions,
  useAnalysisSeason,
} from "../../apps/web/src/analysis/analysis-seasons.js";
import {
  pitcherCatalogQueryOptions,
  batterCatalogQueryOptions,
} from "../../apps/web/src/api/analysis-catalog-query-options.js";
import type { PitchAnalysisCatalog, DisciplineCatalog } from "@kbo/contracts";

const playerCatalogs = [
  { role: "pitcher", endpoint: "pitch-shape", list: "pitchers", id: "pitcherId" },
  { role: "batter", endpoint: "batter-discipline", list: "batters", id: "batterId" },
];
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(url = "/catalog", options: { stale?: boolean; staleTime?: number } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: options.staleTime ?? 0 } },
  });
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
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        url.startsWith("/catalog")
          ? createElement(
              Routes,
              null,
              createElement(
                Route,
                {
                  element: createElement(AnalysisRefreshBoundary, null, createElement(Outlet)),
                },
                createElement(Route, { path: "/catalog", element: createElement(ScopedCatalog) }),
                createElement(Route, { path: "/probe-models", element: createElement(ModelProbe) }),
              ),
            )
          : createElement(App),
      ),
    ),
  );
  return client;
}

function ScopedCatalog() {
  const [params, setParams] = useSearchParams();
  const season = useAnalysisSeason(params.get("season"));
  const options = { competition: "regular" as const };
  const catalog = useQuery<
    PitchAnalysisCatalog | DisciplineCatalog,
    Error,
    ReturnType<typeof analysisCatalogPlayers>
  >({
    ...(params.get("role") === "batter"
      ? batterCatalogQueryOptions(season, options)
      : pitcherCatalogQueryOptions(season, options)),
    select: analysisCatalogPlayers,
  });
  return createElement(
    "div",
    null,
    createElement(
      "select",
      {
        "aria-label": "선수 분석 시즌",
        value: season,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = new URLSearchParams(params);
          next.set("season", event.target.value);
          setParams(next);
        },
      },
      createElement(AnalysisSeasonOptions, { season }),
    ),
    ...(catalog.data ?? []).map((player) =>
      createElement(
        Link,
        {
          key: player.id,
          to: `/analysis/player-statistics?season=${season}`,
        },
        `${player.name} 분석 보기`,
      ),
    ),
    createElement(Link, { to: "/probe-models" }, "분석 모델 관리"),
  );
}

function ModelProbe() {
  const season = useAnalysisSeason(null);
  useQuery({
    queryKey: ["probe-models", season],
    queryFn: () => fetch(`/api/v2/analysis/models?season=${season}`),
  });
  return null;
}

function prepared(season: number, source: string, overrides: Partial<AnalysisPreparation> = {}) {
  return {
    version: 1,
    season,
    sourceHash: source.repeat(64),
    competitionHash: "a".repeat(64),
    state: "ready",
    unclassified: 0,
    updatedAt: "2026-11-21T00:00:00Z",
    error: null,
    ...overrides,
  } satisfies AnalysisPreparation;
}

async function refreshSeasons(client: QueryClient) {
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["analysis-seasons"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("polls settled seasons less often and preserves the status payload and season order", async () => {
  vi.useFakeTimers();
  const ready = {
    sourceHash: "a".repeat(64),
    seasons: [2026, 2024],
    preparation: [
      prepared(2024, "b", { state: "failed", error: "fixture failure" }),
      prepared(2026, "a"),
    ],
  };
  const training = {
    ...ready,
    preparation: [ready.preparation[0], prepared(2026, "a", { state: "models" })],
  };
  const readStatus = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(Response.json(ready))
    .mockResolvedValueOnce(Response.json(training))
    .mockResolvedValueOnce(Response.json(ready))
    .mockResolvedValueOnce(Response.json(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(ready));
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/analysis/seasons")) return readStatus();
    return Promise.resolve(
      Response.json({
        season: 2026,
        scope: resolveAnalysisScope({ season: 2026, competition: "regular" }),
        pitchers: [],
      }),
    );
  });
  const client = show();
  const advance = (milliseconds: number) => act(() => vi.advanceTimersByTimeAsync(milliseconds));
  await advance(0);
  expect(readStatus).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(["analysis-seasons"])).toEqual(ready);
  await advance(1);
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "2026",
    "2024",
  ]);

  await advance(59_998);
  expect(readStatus).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(readStatus).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(["analysis-seasons"])).toEqual(training);

  await advance(14_999);
  expect(readStatus).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(readStatus).toHaveBeenCalledTimes(3);
  expect(client.getQueryData(["analysis-seasons"])).toEqual(ready);
  await advance(59_999);
  expect(readStatus).toHaveBeenCalledTimes(3);
  await advance(1);
  expect(readStatus).toHaveBeenCalledTimes(4);
  await advance(14_999);
  expect(readStatus).toHaveBeenCalledTimes(4);
  await advance(1);
  expect(readStatus).toHaveBeenCalledTimes(5);
  expect(client.getQueryData(["analysis-seasons"])).toEqual(ready);
});

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

it.each(playerCatalogs)(
  "starts the $role catalog for an explicit season after the first status",
  async (catalog) => {
    const season = 2024;
    const seasons = Promise.withResolvers<Response>();
    const requestedSeasons: (string | null)[] = [];
    let playerName = "적재 전 명단";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v2/analysis/seasons") return seasons.promise;
      if (url.pathname !== `/api/v2/analysis/${catalog.endpoint}`) throw new Error(url.pathname);
      requestedSeasons.push(url.searchParams.get("season"));
      return Response.json({
        season,
        scope: resolveAnalysisScope({ season, competition: "regular" }),
        [catalog.list]: [{ [catalog.id]: "anonymous", name: playerName, pitches: 100 }],
      });
    });

    show(`/catalog?season=${season}&role=${catalog.role}`);
    await waitFor(() => {
      expect(
        screen.queryByText("적재 시즌을 확인하고 있습니다.") !== null ||
          requestedSeasons.length > 0,
      ).toBe(true);
    });
    expect(requestedSeasons).toEqual([]);

    playerName = "적재 후 명단";
    await act(async () => {
      seasons.resolve(
        Response.json({
          sourceHash: "b".repeat(64),
          seasons: [2025, season],
          preparation: [prepared(2025, "a"), prepared(season, "b")],
        }),
      );
    });
    await screen.findByRole("link", { name: "적재 후 명단 분석 보기" });
    expect(screen.getByRole("option", { name: "2024", selected: true })).toBeTruthy();
    expect(requestedSeasons).toEqual(["2024"]);
  },
);

it.each(playerCatalogs)("keeps $role usable when the first season check fails", async (catalog) => {
  const recovered = Promise.withResolvers<undefined>();
  const releaseOld = Promise.withResolvers<undefined>();
  const holdOld = catalog.role === "batter";
  const requestedSeasons: (string | null)[] = [];
  let statusCalls = 0;
  let oldSignal: AbortSignal | null | undefined;

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v2/analysis/seasons") {
      if (++statusCalls === 1) return Response.json(null, { status: 503 });
      await recovered.promise;
      return Response.json({ sourceHash: "b".repeat(64), seasons: [2025, 2024], preparation: [] });
    }
    if (url.pathname !== `/api/v2/analysis/${catalog.endpoint}`) throw new Error(url.pathname);
    requestedSeasons.push(url.searchParams.get("season"));
    const first = requestedSeasons.length === 1;
    if (first && holdOld) {
      oldSignal = init?.signal;
      await releaseOld.promise;
    }
    return Response.json({
      season: 2024,
      scope: resolveAnalysisScope({ season: 2024, competition: "regular" }),
      [catalog.list]: [
        { [catalog.id]: "anonymous", name: first ? "장애 중 명단" : "복구 후 명단", pitches: 100 },
      ],
    });
  });

  try {
    const client = show(`/catalog?season=2024&role=${catalog.role}`);
    await screen.findByText(/적재 시즌과 자동 반영 상태를 확인하지 못했습니다/u);
    await waitFor(() => expect(requestedSeasons).toEqual(["2024"]));
    if (!holdOld) await screen.findByRole("link", { name: "장애 중 명단 분석 보기" });

    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    await waitFor(() => expect(statusCalls).toBe(2));
    if (!holdOld) expect(screen.getByRole("link", { name: "장애 중 명단 분석 보기" })).toBeTruthy();
    expect(requestedSeasons).toEqual(["2024"]);

    await act(async () => recovered.resolve(undefined));
    await screen.findByRole("link", { name: "복구 후 명단 분석 보기" });
    if (holdOld) expect(oldSignal?.aborted).toBe(true);
    await act(async () => releaseOld.resolve(undefined));
    await refreshSeasons(client);
    expect(screen.queryByRole("link", { name: "장애 중 명단 분석 보기" })).toBeNull();
    expect(requestedSeasons).toEqual(["2024", "2024"]);
  } finally {
    recovered.resolve(undefined);
    releaseOld.resolve(undefined);
  }
});

it.each(playerCatalogs)("refreshes $role for season changes", async (catalog) => {
  const season = 2024;
  let current = prepared(season, "a");
  let playerName = "가상 선수";
  const requestedSeasons: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v2/analysis/seasons") {
      return Response.json({
        sourceHash: current.sourceHash,
        seasons: [2025, season],
        preparation: [prepared(2025, "f"), current],
      });
    }
    if (url.pathname !== `/api/v2/analysis/${catalog.endpoint}`) throw new Error(url.pathname);
    requestedSeasons.push(url.searchParams.get("season") ?? "");
    return Response.json({
      season,
      scope: resolveAnalysisScope({ season, competition: "regular" }),
      [catalog.list]: [{ [catalog.id]: "anonymous", name: playerName, pitches: 100 }],
    });
  });

  const client = show(`/catalog?season=${season}&role=${catalog.role}`, {
    staleTime: 2_000,
  });
  await screen.findByRole("option", { name: "2025" });
  await screen.findByRole("link", { name: "가상 선수 분석 보기" });
  expect(requestedSeasons).toEqual(["2024"]);

  const now = Date.now;
  vi.spyOn(Date, "now").mockImplementation(() => now() + 2_500);
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(requestedSeasons).toEqual(["2024"]);

  current = prepared(season, "b");
  playerName = "갱신된 가상 선수";
  await refreshSeasons(client);
  await screen.findByRole("link", { name: "갱신된 가상 선수 분석 보기" });
  expect(requestedSeasons).toEqual(["2024", "2024"]);
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

  show("/catalog?season=2025");
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

it("discovers imported seasons and refreshes analysis only when its own source or classification changes", async () => {
  let version = 1;
  let current = prepared(2026, "a");
  let previous = prepared(2024, "a");
  let playerName = "가상 투수";
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/seasons"))
      return Response.json({
        sourceHash: String(version).repeat(64),
        seasons: version === 1 ? [2026, 2024] : [2027, 2026, 2024],
        preparation: version === 1 ? [current, previous] : [prepared(2027, "a"), current, previous],
      });
    if (url.pathname === "/api/v2/analysis/pitch-shape") {
      calls.push(url.search);
      const season = Number(url.searchParams.get("season"));
      return Response.json({
        season,
        scope: resolveAnalysisScope({ season, competition: "regular" }),
        pitchers: [{ pitcherId: "anonymous", name: playerName, pitches: 100 }],
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
  await refreshSeasons(client);
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
  await waitFor(() => expect(client.isFetching()).toBe(0));
  const prior = calls.length;
  version = 3;
  previous = prepared(2024, "b");
  await refreshSeasons(client);
  expect(calls).toHaveLength(prior);

  version = 4;
  current = prepared(2026, "a", { state: "models" });
  await refreshSeasons(client);
  await screen.findByText(/분석 모델을 갱신하고 있습니다/u);
  expect(calls).toHaveLength(prior);

  version = 5;
  current = prepared(2026, "a", { competitionHash: "b".repeat(64) });
  playerName = "분류가 반영된 가상 투수";
  await refreshSeasons(client);
  await screen.findByRole("link", { name: "분류가 반영된 가상 투수 분석 보기" });
  expect(calls.slice(prior)).toHaveLength(1);
  expect(calls.at(-1)).toContain("season=2026");
});

it("restarts a pending first catalog request only when its season changes", async () => {
  let current = prepared(2024, "a");
  let other = prepared(2025, "c");
  const firstResponse = Promise.withResolvers<Response>();
  const signals: (AbortSignal | null | undefined)[] = [];
  const catalog = (name: string) =>
    Response.json({
      season: 2024,
      scope: resolveAnalysisScope({ season: 2024, competition: "regular" }),
      pitchers: [{ pitcherId: "anonymous", name, pitches: 100 }],
    });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v2/analysis/seasons") {
      return Response.json({
        sourceHash: current.sourceHash.slice(0, 32) + other.sourceHash.slice(0, 32),
        seasons: [2025, 2024],
        preparation: [other, current],
      });
    }
    if (
      url.pathname !== "/api/v2/analysis/pitch-shape" ||
      url.searchParams.get("season") !== "2024"
    )
      throw new Error(url.href);
    signals.push(init?.signal);
    return signals.length === 1 ? firstResponse.promise : catalog("새 기록의 선수");
  });

  const client = show("/catalog?season=2024");
  await screen.findByRole("option", { name: "2025" });
  expect(signals).toHaveLength(1);

  other = prepared(2025, "d");
  await refreshSeasons(client);
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);

  current = prepared(2024, "b");
  await refreshSeasons(client);
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]?.aborted).toBe(true);
  await screen.findByRole("link", { name: "새 기록의 선수 분석 보기" });

  await act(async () => firstResponse.resolve(catalog("이전 기록의 선수")));
  await refreshSeasons(client);
  expect(signals).toHaveLength(2);
  expect(screen.queryByRole("link", { name: "이전 기록의 선수 분석 보기" })).toBeNull();
  expect(screen.getByRole("link", { name: "새 기록의 선수 분석 보기" })).toBeTruthy();
});

it("refreshes model status when automatic training for the viewed season settles", async () => {
  let current = prepared(2025, "a");
  let version = 1;
  const modelCalls: (string | null)[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/analysis/seasons")) {
      return Response.json({
        sourceHash: String(version).repeat(64),
        seasons: [2025, 2024],
        preparation: [current, prepared(2024, "b")],
      });
    }
    if (url.pathname !== "/api/v2/analysis/models") throw new Error(url.pathname);
    modelCalls.push(url.searchParams.get("season"));
    return Response.json({
      models: (["re24", "count", "win", "park", "quality", "matchup"] as const).map((kind) => {
        const period = modelTrainingPeriod(kind, 2025);
        return {
          ...period,
          kind,
          state: period.support === "eligible" ? "missing" : "unsupported",
          sourceHash: null,
          modelHash: null,
          adoptedTargets: 0,
          totalTargets: 1,
        };
      }),
      latestJob: null,
      policy: { version: 2, enabledSeasons: [] },
      checkIntervalHours: 6,
    });
  });

  const client = show("/analysis/models?season=2025");
  await screen.findByRole("table", { name: "모델 상태" });
  expect(modelCalls).toEqual(["2025"]);

  version = 2;
  current = prepared(2025, "a", { state: "models" });
  await refreshSeasons(client);
  await screen.findByText(/분석 모델을 갱신하고 있습니다/u);
  expect(modelCalls).toEqual(["2025"]);

  version = 3;
  current = prepared(2025, "a", { updatedAt: "2026-11-21T00:01:00Z" });
  await refreshSeasons(client);
  await waitFor(() => expect(modelCalls).toEqual(["2025", "2025"]));
});

it("loads the global directory independently of season readiness and refreshes after an older season changes", async () => {
  const firstStatus = Promise.withResolvers<Response>();
  const seasonStatus = (hash: string) =>
    Response.json({
      sourceHash: hash.repeat(64),
      seasons: [2026, 2024],
      preparation: [prepared(2026, "a"), prepared(2024, hash)],
    });
  let status: Promise<Response> | undefined = firstStatus.promise;
  let olderHash = "a";
  let name = "가상 선수";
  const directory = vi.fn();
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/seasons"))
      return status ?? Promise.resolve(seasonStatus(olderHash));
    if (url.pathname === "/api/v2/analysis/players") {
      directory(url.search);
      return Promise.resolve(
        Response.json([
          {
            identity: "player:older",
            sourceIds: ["older"],
            name,
            primaryPosition: "유격수",
            teams: ["원정"],
            seasons: [{ season: 2024, battingPlayerId: "older", pitchingPlayerId: null }],
          },
        ]),
      );
    }
    if (url.pathname === "/api/v2/analysis/statistics/player-seasons") {
      return Promise.resolve(
        Response.json({
          query: { player: "player:older", competition: "regular" },
          batting: [],
          pitching: [],
        }),
      );
    }
    throw new Error(url.href);
  });
  const client = show("/analysis/players");
  await screen.findByRole("link", { name: "가상 선수 분석 보기" });
  expect(directory.mock.calls).toEqual([[""]]);
  status = undefined;
  await act(async () => firstStatus.resolve(seasonStatus("a")));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  olderHash = "b";
  name = "갱신된 선수";
  await refreshSeasons(client);
  await screen.findByRole("link", { name: "갱신된 선수 분석 보기" });
  expect(directory.mock.calls).toEqual([[""], [""]]);
  fireEvent.click(screen.getByRole("link", { name: "갱신된 선수 분석 보기" }));
  const modes = await screen.findByRole("navigation", { name: "선수 기록 보기" });
  expect(modes.textContent).toBe("기본 기록경기별상황별구종·코스맞대결");
  expect(screen.getByRole("combobox", { name: "분석 시즌" })).toHaveProperty("value", "2024");
  await screen.findByText(/선택한 범위에 이 선수의 기본 기록이 없습니다/);
});
