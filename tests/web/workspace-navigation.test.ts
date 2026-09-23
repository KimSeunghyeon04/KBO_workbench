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
    location.pathname + location.search + location.hash,
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
  expect(within(menu).queryByRole("link", { name: "선수 분석" })).toBeNull();
  await user.click(within(menu).getByRole("link", { name: "수집" }));
  await user.click(screen.getByRole("link", { name: "분석", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(
    "/analysis/pitch-shape?season=2024&pitcher=69446&color=cluster",
  );
  await user.click(screen.getByRole("link", { name: "데이터 관리" }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe("/collect");
});
it.each([
  "//example.com/analysis/pitch-shape",
  "https://example.com/analysis/players",
  "/analysis/unknown",
  "/collect",
])("ignores the invalid remembered analysis destination %s", (destination) => {
  sessionStorage.setItem("kbo.workspace.analysis", destination);
  render(createElement(MemoryRouter, null, createElement(AppShell)));
  expect(screen.getByRole("link", { name: "분석", exact: true }).getAttribute("href")).toBe(
    "/analysis/players",
  );
});

it("opens player discovery when analysis has no remembered destination", async () => {
  const user = userEvent.setup();
  render(createElement(MemoryRouter, null, createElement(AppShell, null, createElement(Location))));
  await user.click(screen.getByRole("link", { name: "분석", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe("/analysis/players");
  expect(screen.getByRole("link", { name: "선수 분석" }).getAttribute("aria-current")).toBe("page");
});

it("remembers a batter detail outside the sidebar and returns to player discovery with its scope", async () => {
  const user = userEvent.setup();
  const destination =
    "/analysis/matchups?season=2024&competition=all&dateFrom=2024-04-01&dateTo=2024-04-30&batter=ab1&playerRole=batter#comparison";
  sessionStorage.setItem("kbo.workspace.analysis", destination);
  render(createElement(MemoryRouter, null, createElement(AppShell, null, createElement(Location))));
  await user.click(screen.getByRole("link", { name: "분석", exact: true }));
  expect(screen.getByLabelText("현재 주소").textContent).toBe(destination);
  const playerLink = within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("link", {
    name: "선수 분석",
  });
  expect(playerLink.getAttribute("aria-current")).toBe("page");
  await user.click(playerLink);
  const directory = new URL(
    screen.getByLabelText("현재 주소").textContent ?? "",
    "http://localhost",
  );
  expect(directory.pathname).toBe("/analysis/players");
  expect(Object.fromEntries(directory.searchParams)).toEqual({
    season: "2024",
    competition: "all",
    dateFrom: "2024-04-01",
    dateTo: "2024-04-30",
    role: "batter",
  });
  expect(directory.hash).toBe("");
});
