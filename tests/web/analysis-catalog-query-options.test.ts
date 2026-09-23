// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import {
  batterCatalogQueryOptions,
  pitcherCatalogQueryOptions,
} from "../../apps/web/src/api/analysis-catalog-query-options.js";
import { PitchOutcomesPage } from "../../apps/web/src/pages/pitch-outcomes-page.js";
import { PitchSequencesPage } from "../../apps/web/src/pages/pitch-sequences-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function catalogResponse(input: RequestInfo | URL) {
  const url = new URL(String(input), "http://localhost");
  const { season, ...options } = Object.fromEntries(url.searchParams);
  return {
    season: Number(season),
    scope: resolveAnalysisScope({ season: Number(season), ...options }),
    ...(url.pathname.endsWith("pitch-shape") ? { pitchers: [] } : { batters: [] }),
  };
}

it("shares one catalog request between outcome and sequence pages with the same scope", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(catalogResponse(input)));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/?season=2024&competition=regular&dateFrom=2024-04-01"] },
        createElement(PitchOutcomesPage, { role: "pitcher" }),
        createElement(PitchSequencesPage),
      ),
    ),
  );
  expect(
    await screen.findByRole("heading", { name: "선택한 범위에 분석할 선수가 없습니다" }),
  ).toBeTruthy();
  expect(await screen.findByText("이 범위에 수집된 투수가 없습니다.")).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  cleanup();
  client.clear();
});

it("deduplicates implicit and explicit all-game scopes without changing freshness", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(catalogResponse(input)));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const [implicit, explicit] = await Promise.all([
    client.fetchQuery(pitcherCatalogQueryOptions(2024, {})),
    client.fetchQuery(pitcherCatalogQueryOptions(2024, { competition: "all" })),
  ]);
  expect(explicit).toBe(implicit);
  expect(fetch).toHaveBeenCalledTimes(1);
  await client.fetchQuery(pitcherCatalogQueryOptions(2024, {}));
  expect(fetch).toHaveBeenCalledTimes(2);
  client.clear();
});

it("keeps season, date, competition and player role isolated", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(catalogResponse(input)));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const responses = await Promise.all([
    client.fetchQuery(pitcherCatalogQueryOptions(2024, {})),
    client.fetchQuery(pitcherCatalogQueryOptions(2025, {})),
    client.fetchQuery(pitcherCatalogQueryOptions(2024, { competition: "regular" })),
    client.fetchQuery(pitcherCatalogQueryOptions(2024, { dateFrom: "2024-04-01" })),
    client.fetchQuery(pitcherCatalogQueryOptions(2024, { dateTo: "2024-08-31" })),
    client.fetchQuery(batterCatalogQueryOptions(2024, {})),
  ]);
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(client.getQueryCache().getAll()).toHaveLength(6);
  expect(responses.map((response) => response.scope)).toEqual([
    resolveAnalysisScope({ season: 2024 }),
    resolveAnalysisScope({ season: 2025 }),
    resolveAnalysisScope({ season: 2024, competition: "regular" }),
    resolveAnalysisScope({ season: 2024, dateFrom: "2024-04-01" }),
    resolveAnalysisScope({ season: 2024, dateTo: "2024-08-31" }),
    resolveAnalysisScope({ season: 2024 }),
  ]);
  expect(responses[5]).toHaveProperty("batters");
  client.clear();
});

it("propagates query cancellation to the shared fetch", async () => {
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = pitcherCatalogQueryOptions(2024, {});
  const pending = client.fetchQuery(options).catch((error: unknown) => error);
  await client.cancelQueries({ queryKey: options.queryKey });
  expect(signal?.aborted).toBe(true);
  expect(await pending).toBeInstanceOf(Error);
  expect(client.getQueryData(options.queryKey)).toBeUndefined();
  client.clear();
});

it.each(["scope", "schema"])(
  "keeps %s validation at the catalog response boundary",
  async (problem) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const response = catalogResponse(input);
        return Response.json(
          problem === "scope"
            ? { ...response, scope: resolveAnalysisScope({ season: 2025 }) }
            : { ...response, unrecognized: true },
        );
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(pitcherCatalogQueryOptions(2024, {}))).rejects.toThrow();
    await expect(client.fetchQuery(batterCatalogQueryOptions(2024, {}))).rejects.toThrow();
    client.clear();
  },
);
