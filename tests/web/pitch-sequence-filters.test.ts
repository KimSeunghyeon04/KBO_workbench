// @vitest-environment jsdom
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PitchSequenceQuerySchema, resolveAnalysisScope } from "@kbo/contracts";
import { analyzePitchSequences } from "@kbo/game-core";
import { PitchSequencesPage } from "../../apps/web/src/pages/pitch-sequences-page.js";
import { PlayerAnalysisFrame } from "../../apps/web/src/analysis/player-analysis-frame.js";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return createElement(
    "div",
    null,
    createElement("output", { "aria-label": "현재 주소" }, location.search),
    createElement("button", { onClick: () => navigate(-1) }, "뒤로"),
  );
}

function show(search: string) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const raw = Object.fromEntries(url.searchParams);
    const query = Value.Decode(PitchSequenceQuerySchema, {
      ...raw,
      season: Number(raw.season),
      ...(raw.balls === undefined ? {} : { balls: Number(raw.balls) }),
      ...(raw.strikes === undefined ? {} : { strikes: Number(raw.strikes) }),
    });
    const scope = resolveAnalysisScope(
      {
        season: query.season,
        ...(query.competition === undefined ? {} : { competition: query.competition }),
        ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
        ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
      },
      "regular",
    );
    if (url.pathname.endsWith("pitch-shape"))
      return Response.json({
        season: query.season,
        scope,
        pitchers: (query.season === 2024 ? ["p1", "p2"] : ["p2"]).map((pitcherId) => ({
          pitcherId,
          name: pitcherId,
          pitches: 1,
        })),
      });
    return Response.json(
      analyzePitchSequences(query, url.pathname.split("/").at(-1) ?? "", scope, "a".repeat(64), []),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const client = createAnalysisQueryClient();
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [`/analysis/pitch-sequences?${search}`] },
        createElement(PlayerAnalysisFrame, null, createElement(PitchSequencesPage)),
        createElement(Location),
      ),
    ),
  );
  return fetch;
}

it("reveals restored situation filters outside the disclosure and clears them individually by keyboard", async () => {
  const initial =
    "season=2024&competition=unknown&dateFrom=2024-06-01&dateTo=2024-06-30&pitcher=p2&previousType=직구&pitchType=슬라이더&balls=0&strikes=2&stance=L&cohort=discipline";
  show(initial);
  await screen.findByRole("table", { name: "두 구종 조합" });
  const details = screen.getByText("조회 조건 변경").closest("details");
  expect(details).toHaveProperty("open", false);
  expect(details?.querySelector("summary")?.textContent).toContain("첫 구종: 직구");
  expect(details?.querySelector("summary")?.textContent).toContain("두 번째 2스트라이크");
  const conditions = within(screen.getByRole("group", { name: "적용된 배합 조건" }));
  expect(conditions.getByRole("button", { name: "두 번째 0볼 조건 해제" })).toBeTruthy();
  expect(conditions.getByRole("button", { name: "좌타자 조건 해제" })).toBeTruthy();
  const user = userEvent.setup();
  conditions.getByRole("button", { name: "첫 구종: 직구 조건 해제" }).focus();
  await user.keyboard("{Enter}");
  let params = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(params.has("previousType")).toBe(false);
  expect(params.get("pitchType")).toBe("슬라이더");
  expect(params.get("balls")).toBe("0");
  expect(params.get("pitcher")).toBe("p2");
  await user.click(screen.getByRole("button", { name: "배합 조건 초기화" }));
  params = new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "");
  expect(Object.fromEntries(params)).toEqual({
    season: "2024",
    competition: "unknown",
    dateFrom: "2024-06-01",
    dateTo: "2024-06-30",
    pitcher: "p2",
  });
  expect(screen.getByText("모든 배합 상황")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "뒤로" }));
  expect(conditions.getByRole("button", { name: "두 번째 2스트라이크 조건 해제" })).toBeTruthy();
  expect(conditions.getByRole("button", { name: "선구안 표본 조건 해제" })).toBeTruthy();
});

it("pins an implicit pitcher on season change and keeps its ID when the next catalog lacks it", async () => {
  const fetch = show("season=2024&dateFrom=2024-06-01&strikes=2");
  await screen.findByRole("table", { name: "두 구종 조합" });
  expect(screen.getByText("p1", { exact: true })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("분석 시즌"), { target: { value: "2025" } });
  await screen.findByText("해당 범위 기록 없음");
  expect(screen.getByText("p1", { exact: true })).toBeTruthy();
  expect(
    Object.fromEntries(new URLSearchParams(screen.getByLabelText("현재 주소").textContent ?? "")),
  ).toEqual({ season: "2025", strikes: "2", pitcher: "p1" });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([input]) => {
        const url = new URL(String(input), "http://localhost");
        return url.pathname.endsWith("/p1") && url.searchParams.get("season") === "2025";
      }),
    ).toBe(true),
  );
  expect(
    fetch.mock.calls.some(([input]) =>
      new URL(String(input), "http://localhost").pathname.endsWith("/p2"),
    ),
  ).toBe(false);
});
