// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "../../apps/web/src/pages/dashboard-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard system status", () => {
  it("집계 요청이 실패해도 독립 진단이 정상이면 API와 DB를 정상으로 표시한다", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "/api/v2/system/status") {
        return Response.json({
          status: "ready",
          apiVersion: "1.0.0",
          browser: {
            installed: true,
            version: "1.62.0",
            executablePath: "/playwright/chromium",
            message: "정상",
          },
          database: {
            reachable: true,
            healthy: true,
            serverMajorVersion: 16,
            expectedServerMajorVersion: 16,
            migrationVersion: "0004_pitch_metadata",
            expectedMigrationVersion: "0004_pitch_metadata",
            message: "정상",
          },
          workspace: {
            writable: true,
            path: "/var/lib/kbo",
            message: "정상",
          },
          recentFailures: [],
        });
      }
      throw new Error("집계 요청 실패");
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MemoryRouter, null, createElement(DashboardPage)),
      ),
    );

    expect(await screen.findByText("집계 요청 실패")).not.toBeNull();
    const apiDatabase = screen.getByText("API / DB").parentElement;
    expect(apiDatabase?.textContent).toContain("정상");
    const corrections = screen.getByRole("link", { name: /KBO 기록정정 검토/ });
    expect(corrections.textContent).toContain("확인 필요");
    expect(corrections.textContent).not.toContain("0건");
    for (const [label, destination] of [
      ["수집", "/collect"],
      ["보정", "/correct"],
      ["저장", "/database"],
      ["재생", "/replay"],
    ] as const) {
      const link = screen
        .getAllByRole("link")
        .find((link) => link.getAttribute("href") === destination);
      expect(link?.textContent).toContain(label);
    }
    expect(screen.queryByText("준비 중")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/system/status",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    queryClient.clear();
  });
});
