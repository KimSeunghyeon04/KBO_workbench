// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "../../apps/web/src/components/app-shell.js";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function Location() {
  const location = useLocation();
  return createElement(
    "output",
    { "aria-label": "현재 주소" },
    location.pathname + location.search,
  );
}
it("switches workspace menus and restores each workspace's URL including analysis filters", async () => {
  const user = userEvent.setup();
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/analysis/pitch-shape?season=2024&pitcher=69446&color=cluster"] },
      createElement(AppShell, null, createElement(Location)),
    ),
  );
  const menu = screen.getByRole("navigation", { name: "주 메뉴" });
  expect(within(menu).queryByRole("link", { name: "수집" })).toBeNull();
  expect(within(menu).getByRole("link", { name: "경기 재생" })).toBeTruthy();
  await user.click(screen.getByRole("link", { name: "데이터 관리" }));
  expect(within(menu).queryByRole("link", { name: "투구 움직임" })).toBeNull();
  await user.click(within(menu).getByRole("link", { name: "수집" }));
  await user.click(screen.getByRole("link", { name: "분석", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/pitch-shape?season=2024&pitcher=69446&color=cluster",
  );
  await user.click(screen.getByRole("link", { name: "데이터 관리" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe("/collect");
});
it("ignores external or unknown remembered destinations", async () => {
  sessionStorage.setItem("kbo.workspace.analysis", "//example.com/analysis/pitch-shape");
  render(createElement(MemoryRouter, null, createElement(AppShell)));
  expect(screen.getByRole("link", { name: "분석", exact: true }).getAttribute("href")).toBe(
    "/analysis/pitch-shape",
  );
});
