// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router-dom";
import type { CollectionDiscovery, CollectionGameSummary } from "@kbo/contracts";
import { CollectPage } from "../../apps/web/src/pages/collect-page.js";
import {
  collectionLevel,
  collectionNavigationKey,
  koreaToday,
  restoredParams,
} from "../../apps/web/src/collection/navigation.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const range = { startDate: "2026-01-01", endDate: "2026-12-31" };
const discovery: CollectionDiscovery = {
  discoveryId: "saved-discovery",
  range,
  status: "succeeded",
  createdAt: "2026-09-05T00:00:00.000Z",
  finishedAt: "2026-09-05T00:00:01.000Z",
  pageCount: 2,
  gameCount: 601,
  complete: true,
  error: null,
};
const counts = {
  total: 601,
  uncollected: 600,
  staging: 0,
  quarantine: 1,
  source_failure: 0,
  database: 0,
};
function game(id: string): CollectionGameSummary {
  return {
    gameId: id,
    gameDate: "2026-04-01",
    label: `비식별 ${id} 경기`,
    scheduledAt: null,
    state: "uncollected",
    databaseRevision: null,
    workspace: null,
    updatedAt: null,
    blockingFindings: 0,
    warningFindings: 0,
  };
}
function setup(complete = true) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v2/collection-jobs") return Response.json({ jobs: [] });
    if (url.pathname === "/api/v2/collection-discoveries")
      return Response.json({
        discoveries: [{ ...discovery, complete, status: complete ? "succeeded" : "failed" }],
      });
    if (url.pathname.endsWith("/overview")) {
      const month = url.searchParams.get("groupBy") === "month";
      return Response.json({
        discovery: { ...discovery, complete },
        counts: { ...counts, uncollected: complete ? 600 : null },
        unknownDateCount: 0,
        groups: [
          {
            key: month ? "2026-04" : "2026-04-01",
            startDate: "2026-04-01",
            endDate: month ? "2026-04-30" : "2026-04-01",
            counts,
          },
        ],
      });
    }
    if (url.pathname === `/api/v2/collection-discoveries/${discovery.discoveryId}`)
      return Response.json({ ...discovery, complete, status: complete ? "succeeded" : "failed" });
    if (url.pathname.endsWith("/games")) {
      const page = Number(url.searchParams.get("page") ?? 1),
        limit = Number(url.searchParams.get("limit") ?? 50);
      const filtered = url.searchParams.get("state") === "quarantine";
      return Response.json({
        games: filtered ? [] : [game(page === 1 ? "first" : "second")],
        total: filtered ? 0 : 600,
        page,
        limit,
      });
    }
    if (url.pathname === "/api/v2/collection-selections") {
      expect(init?.method).toBe("POST");
      return Response.json(
        {
          requestId: "test",
          code: "selection_changed",
          category: "domain",
          message: "검증용 선택 종료",
          retryable: false,
          details: [],
        },
        { status: 409 },
      );
    }
    if (url.pathname === "/api/v2/collection-history")
      return Response.json({ records: [], total: 0, page: 1, limit: 50 });
    throw new Error(`unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/collect?start=2026-01-01&end=2026-12-31"] },
        createElement(CollectPage),
        createElement(Back),
      ),
    ),
  );
  return { fetch, client, user: userEvent.setup() };
}
function Back() {
  const navigate = useNavigate();
  return createElement(
    "button",
    {
      onClick: () => {
        void navigate(-1);
      },
    },
    "브라우저 뒤로",
  );
}

describe("기간별 수집 화면", () => {
  it("월→날짜→경기를 탐색해도 실행 범위가 유지되고 필터에서 제외된 상세는 닫힌다", async () => {
    const { user, fetch, client } = setup();
    await screen.findByRole("heading", { name: "월별 현황" });
    expect(await screen.findByRole("button", { name: "미수집 600경기 수집" })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "2026-04", exact: true }));
    await screen.findByRole("heading", { name: "날짜별 현황" });
    await user.click(await screen.findByRole("button", { name: "2026-04-01", exact: true }));
    await user.click(await screen.findByRole("button", { name: "비식별 first 경기" }));
    expect(screen.getByRole("complementary", { name: "경기 상세" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "수집 실행 대상" })).getByText(
        "2026-01-01 ~ 2026-12-31",
      ),
    ).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "표시 상태" }), "quarantine");
    expect(screen.queryByRole("complementary", { name: "경기 상세" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await screen.findByRole("button", { name: "비식별 first 경기" });
    expect(fetch.mock.calls.every(([input]) => !String(input).startsWith("/api/v2/games"))).toBe(
      true,
    );
    expect(
      fetch.mock.calls
        .filter(([, init]) => init?.method === undefined)
        .every(([, init]) => init?.signal instanceof AbortSignal),
    ).toBe(true);
    client.clear();
  });
  it("페이지를 넘긴 개별 제외와 전체 조건을 서버에 보내며 입력 중에는 일정 요청을 만들지 않는다", async () => {
    const { user, fetch, client } = setup();
    await screen.findByRole("heading", { name: "월별 현황" });
    await user.type(screen.getByRole("searchbox"), "비식별");
    await user.click(await screen.findByRole("checkbox", { name: "비식별 first 경기 수집 선택" }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(await screen.findByRole("checkbox", { name: "비식별 second 경기 수집 선택" }));
    await user.click(screen.getByRole("button", { name: "수집 기록", exact: true }));
    await screen.findByText("아직 보존된 수집 기록이 없습니다.");
    await user.click(screen.getByRole("button", { name: "수집 현황", exact: true }));
    await screen.findByRole("button", { name: "미수집 598경기 수집" });
    await user.click(screen.getByRole("button", { name: "미수집 598경기 수집" }));
    await screen.findByText("검증용 선택 종료");
    const request = fetch.mock.calls.find(
      ([input]) => String(input) === "/api/v2/collection-selections",
    )?.[1]?.body;
    expect(typeof request).toBe("string");
    expect(JSON.parse(String(request))).toMatchObject({
      range,
      mode: "all_matching",
      target: "uncollected",
      excludedGameIds: ["first", "second"],
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "범위" }), "season");
    await user.clear(screen.getByRole("spinbutton", { name: "시즌" }));
    await user.type(screen.getByRole("spinbutton", { name: "시즌" }), "2025");
    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/v2/collection-discoveries" && init?.method === "POST",
      ),
    ).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "수집 기록" }));
    await screen.findByText("아직 보존된 수집 기록이 없습니다.");
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes("collection-history?page=1&limit=50"),
      ),
    ).toBe(true);
    client.clear();
  });
  it("미완료 일정은 —로 표시하고 실행 버튼을 비활성화한다", async () => {
    const { client } = setup(false);
    const button = await screen.findByRole("button", { name: "미수집 —경기 수집" });
    expect(button.hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(screen.getByText(/미수집 수는 아직 알 수 없습니다/)).toBeTruthy());
    client.clear();
  });
  it("한국 날짜, URL 우선순위, 마지막 탐색 위치와 범위별 시작 단계를 복원한다", () => {
    expect(koreaToday(new Date("2026-09-04T16:00:00Z"))).toBe("2026-09-05");
    const saved = "start=2026-01-01&end=2026-12-31&from=2026-04-01&to=2026-04-30";
    expect(restoredParams(new URLSearchParams(), saved).get("from")).toBe("2026-04-01");
    expect(
      restoredParams(new URLSearchParams("start=2025-01-01&end=2025-01-01"), saved).get("start"),
    ).toBe("2025-01-01");
    expect(collectionLevel(range)).toBe("month");
    expect(collectionLevel({ startDate: "2026-04-01", endDate: "2026-04-30" })).toBe("day");
    expect(collectionLevel({ startDate: "2026-04-01", endDate: "2026-04-01" })).toBe("games");
    expect(collectionNavigationKey).toContain("collection");
  });
});
