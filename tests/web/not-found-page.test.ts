// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAnalysisQueryClient } from "../helpers/analysis-query-client.js";
import { App } from "../../apps/web/src/app.js";

afterEach(cleanup);

it.each(["/unknown", "/analysis/unknown"])(
  "provides recovery destinations for the unknown route %s instead of an empty main",
  (path) => {
    render(
      createElement(
        QueryClientProvider,
        { client: createAnalysisQueryClient() },
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(App)),
      ),
    );
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "페이지를 찾을 수 없습니다" })).toBeTruthy();
    expect(
      within(main).getByRole("link", { name: "선수 분석으로 이동" }).getAttribute("href"),
    ).toBe("/analysis/players");
    expect(
      within(main).getByRole("link", { name: "데이터 관리 홈으로 이동" }).getAttribute("href"),
    ).toBe("/");
  },
);
