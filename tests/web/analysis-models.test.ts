// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisModelsPage } from "../../apps/web/src/pages/analysis-models-page.js";
import { AnalysisRefreshBoundary } from "../../apps/web/src/analysis/analysis-seasons.js";
import { getAnalysisModels } from "../../apps/web/src/api/analysis-model-client.js";
import { modelTrainingPeriod } from "@kbo/game-core";
import type { AnalysisModelKind } from "@kbo/contracts";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModels(client: QueryClient, url = "/analysis/models") {
  function ModelUrl() {
    return createElement("span", { "aria-label": "모델 URL" }, useLocation().search);
  }
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [url] },
        createElement(AnalysisRefreshBoundary),
        createElement(AnalysisModelsPage),
        createElement(ModelUrl),
      ),
    ),
  );
}

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
  const client = createAnalysisQueryClient();
  renderModels(client);
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
  const client = createAnalysisQueryClient();
  renderModels(client);
  expect(await screen.findByRole("table", { name: "모델 상태" })).toBeTruthy();
  expect(screen.getAllByText("최신")).toHaveLength(6);
  expect(screen.getByText(/최신 여부와 검증 채택은 별개/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "2025 시즌 6시간 주기 점검" }));
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

it("shares the URL season across the selector, model request, and accessible preparation status", async () => {
  const client = createAnalysisQueryClient();
  const hash = "a".repeat(64);
  client.setQueryData(["analysis-seasons"], {
    sourceHash: hash,
    seasons: [2026, 2024],
    preparation: [
      { season: 2024, state: "failed", unclassified: 1, error: "2024 일정 확인 실패" },
      { season: 2026, state: "ready", unclassified: 2, error: null },
    ].map((entry) => ({
      ...entry,
      version: 1,
      sourceHash: hash,
      competitionHash: hash,
      updatedAt: "2026-06-01T00:00:00Z",
    })),
  });
  const requested: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname !== "/api/v2/analysis/models") throw new Error(url.pathname);
      const season = url.searchParams.get("season");
      requested.push(season);
      return Response.json({
        models: (
          ["re24", "count", "win", "park", "quality", "matchup"] satisfies AnalysisModelKind[]
        ).map((kind) => {
          const period = modelTrainingPeriod(kind, Number(season));
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
    }),
  );
  renderModels(client, "/analysis/models?season=2024&other=kept");
  await screen.findByRole("table", { name: "모델 상태" });
  expect(screen.getByRole("option", { name: "2024", selected: true })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("2024 일정 확인 실패");
  expect(requested).toEqual(["2024"]);

  fireEvent.change(screen.getByRole("combobox", { name: "적용 시즌" }), {
    target: { value: "2026" },
  });
  await screen.findByRole("table", { name: "모델 상태" });
  expect(screen.getByRole("option", { name: "2026", selected: true })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "2026시즌 공식 일정과 연결되지 않은 2경기",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  const params = new URLSearchParams(screen.getByLabelText("모델 URL").textContent ?? "");
  expect(params.get("season")).toBe("2026");
  expect(params.get("other")).toBe("kept");
  expect(requested).toEqual(["2024", "2026"]);
  client.clear();
});

it("polls the durable job and refreshes one full response for the selected season on completion", async () => {
  const kinds = ["re24", "count", "win", "park", "quality", "matchup"] as const;
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  let finished = false;
  const job = () => ({
    version: 2,
    applicationSeason: 2025,
    id,
    force: false,
    trigger: "manual",
    sequence: finished ? 3 : 2,
    state: finished ? "succeeded" : "running",
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    error: null,
    steps: kinds.map((kind) => ({
      kind,
      state: finished ? "skipped" : "pending",
      phase: finished ? "done" : "waiting",
      modelHash: null,
    })),
  });
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      requests.push(input);
      if (input === `/api/v2/analysis/model-jobs/${id}`) return Response.json(job());
      expect(input).toBe("/api/v2/analysis/models?season=2024");
      return Response.json({
        models: kinds.map((kind) => {
          const period = modelTrainingPeriod(kind, 2024);
          return {
            ...period,
            kind,
            state:
              period.support === "eligible" ? (finished ? "current" : "missing") : "unsupported",
            sourceHash: null,
            modelHash: null,
            adoptedTargets: 0,
            totalTargets: 1,
          };
        }),
        latestJob: job(),
        policy: { version: 2, enabledSeasons: [] },
        checkIntervalHours: 6,
      });
    }),
  );
  const client = createAnalysisQueryClient();
  renderModels(client, "/analysis/models?season=2024");
  await screen.findByRole("table", { name: "모델 상태" });
  const modelsUrl = "/api/v2/analysis/models?season=2024";
  const jobUrl = `/api/v2/analysis/model-jobs/${id}`;
  await waitFor(() => expect(requests).toEqual([modelsUrl, jobUrl]));
  finished = true;
  expect(await screen.findAllByText("최신", {}, { timeout: 4500 })).toHaveLength(5);
  expect(requests).toEqual([modelsUrl, jobUrl, jobUrl, modelsUrl]);
  client.clear();
}, 8000);
