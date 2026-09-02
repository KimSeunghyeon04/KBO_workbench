// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueryClient,
  QueryClientProvider,
} from "../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js";
import { MemoryRouter } from "../../apps/web/node_modules/react-router-dom/dist/index.mjs";
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
            migrationVersion: "0003_record_correction_scope_classification",
            expectedMigrationVersion: "0003_record_correction_scope_classification",
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
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v2/system/status",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    queryClient.clear();
  });
});
