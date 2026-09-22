// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisModelsPage } from "../../apps/web/src/pages/analysis-models-page.js";
import { getAnalysisModels } from "../../apps/web/src/api/analysis-model-client.js";
import { modelTrainingPeriod } from "@kbo/game-core";
import type { AnalysisModelKind } from "@kbo/contracts";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("selects historical periods, submits the selected season and disables insufficient-history training", async () => {
  const requests: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const season = Number(new URL(url, "http://localhost").searchParams.get("season") ?? 2025);
    if (init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({
        version: 2,
        applicationSeason: 2023,
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        force: false,
        trigger: "manual",
        sequence: 1,
        state: "succeeded",
        createdAt: "2026-09-21T00:00:00Z",
        updatedAt: "2026-09-21T00:00:00Z",
        error: null,
        steps: ["re24", "count", "win", "park", "quality", "matchup"].map((kind) => ({
          kind,
          state: "skipped",
          phase: "done",
          modelHash: null,
        })),
      });
    }
    return Response.json({
      models: (
        ["re24", "count", "win", "park", "quality", "matchup"] satisfies AnalysisModelKind[]
      ).map((kind) => {
        const period = modelTrainingPeriod(kind, season);
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
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(AnalysisModelsPage)));
  await screen.findByRole("table", { name: "모델 상태" });
  fireEvent.change(screen.getByRole("combobox", { name: "적용 시즌" }), {
    target: { value: "2023" },
  });
  await screen.findAllByText(/검증: 2021, 2022/);
  fireEvent.click(screen.getByRole("button", { name: "필요한 모델 갱신" }));
  await waitFor(() =>
    expect(requests).toEqual([expect.objectContaining({ applicationSeason: 2023, force: false })]),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "적용 시즌" }), {
    target: { value: "2020" },
  });
  await screen.findByText(/이 시즌은 관측 통계만/);
  expect(screen.getByRole("button", { name: "필요한 모델 갱신" }).hasAttribute("disabled")).toBe(
    true,
  );
  client.clear();
});
it("shows adoption separately from freshness and explicitly enables persisted automatic refresh", async () => {
  const data = {
    models: ["re24", "count", "win", "park", "quality", "matchup"].map((kind) => ({
      kind,
      trainingStartSeason: 2020,
      validationSeasons: [2023, 2024],
      support: "eligible",
      trainedThrough: 2024,
      applicationSeason: 2025,
      state: "current",
      sourceHash: "a".repeat(64),
      modelHash: "b".repeat(64),
      adoptedTargets: 0,
      totalTargets: 1,
    })),
    latestJob: null,
    policy: { version: 2, enabledSeasons: [] as number[] },
    checkIntervalHours: 6,
  };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      data.policy.enabledSeasons = [2025];
      return Response.json(data.policy);
    }
    return Response.json(data);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(AnalysisModelsPage)));
  expect(await screen.findByRole("table", { name: "모델 상태" })).toBeTruthy();
  expect(screen.getAllByText("최신")).toHaveLength(6);
  expect(screen.getByText(/최신 여부와 검증 채택은 별개/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "2025 시즌 자료 자동 갱신" }));
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...data, unsafe: true })),
  );
  await expect(getAnalysisModels()).rejects.toThrow();
  client.clear();
});
