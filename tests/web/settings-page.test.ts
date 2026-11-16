// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SystemStatus } from "@kbo/contracts";
import { SettingsPage } from "../../apps/web/src/pages/settings-page.js";

const status: SystemStatus = {
  status: "ready",
  apiVersion: "test",
  browser: {
    installed: true,
    version: "test",
    executablePath: "/preview/chromium",
    message: "정상",
  },
  database: {
    reachable: true,
    healthy: true,
    serverMajorVersion: 16,
    expectedServerMajorVersion: 16,
    migrationVersion: "test-migration",
    expectedMigrationVersion: "test-migration",
    message: "정상",
  },
  workspace: { writable: true, path: "/preview/workspace", message: "정상" },
  recentFailures: [
    {
      kind: "collection",
      jobId: "collection:작업 /1&detail",
      gameId: null,
      category: "source",
      message: "가상 수집 작업을 확인해 주세요.",
      occurredAt: "2025-06-01T00:00:00Z",
    },
    {
      kind: "import",
      jobId: "import:작업 /2&detail",
      gameId: "preview-game",
      category: "persistence",
      message: "가상 적재 작업을 확인해 주세요.",
      occurredAt: "2025-06-02T00:00:00Z",
    },
  ],
};

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: ["/settings"] }, createElement(SettingsPage)),
    ),
  );
}

it("recovers a failed diagnosis only after an explicit read retry without creating jobs", async () => {
  let completeRetry: ((response: Response) => void) | undefined;
  const pending = new Promise<Response>((resolve) => {
    completeRetry = resolve;
  });
  const fetch = vi
    .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockReturnValueOnce(pending);
  vi.stubGlobal("fetch", fetch);
  show();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("시스템 상태를 확인하지 못했습니다.");
  expect(alert.textContent).toContain("요청에 실패했습니다 (503)");
  expect(alert.textContent).not.toContain("ApiClientError");
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "진단 다시 시도" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const retry = screen.queryByRole<HTMLButtonElement>("button", { name: "진단 다시 시도" });
  expect(retry === null || retry.disabled).toBe(true);
  if (completeRetry === undefined) throw new Error("Diagnosis retry was not requested");
  completeRetry(Response.json(status));

  await screen.findByText("PostgreSQL 16");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET"])).toEqual([
    ["/api/v2/system/status", "GET"],
    ["/api/v2/system/status", "GET"],
  ]);
});

it.each([
  ["collection", "수집 작업 결과 보기", "/collect", "tab", "history"],
  ["import", "DB 적재 작업 결과 보기", "/database", "scope", "jobs"],
] as const)(
  "links a %s failure to its existing job history consumer",
  async (kind, label, path, key, value) => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json(status),
    );
    vi.stubGlobal("fetch", fetch);
    show();
    const failure = status.recentFailures.find((item) => item.kind === kind);
    if (failure === undefined) throw new Error("Missing failure fixture");

    const link = await screen.findByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe(
      `${path}?${key}=${value}&job=${encodeURIComponent(failure.jobId)}`,
    );
    const destination = new URL(link.getAttribute("href") ?? "", "http://localhost");
    expect(destination.pathname).toBe(path);
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      [key]: value,
      job: failure.jobId,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.map(([input, init]) => [String(input), init?.method ?? "GET"])).toEqual(
      [["/api/v2/system/status", "GET"]],
    );
  },
);
