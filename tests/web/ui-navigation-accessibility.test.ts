// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AppShell } from "../../apps/web/src/components/app-shell.js";
import { WorkspaceTabs } from "../../apps/web/src/components/workspace-tabs.js";
import { SelectableVirtualList } from "../../apps/web/src/components/selectable-virtual-list.js";
import { OperationConsole } from "../../apps/web/src/components/operation-console.js";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("keeps player details out of the seven workspace destinations and closes the menu accessibly", async () => {
  const user = userEvent.setup();
  render(
    createElement(
      MemoryRouter,
      { initialEntries: ["/analysis/pitch-shape"] },
      createElement(AppShell, null, createElement("h1", null, "분석 본문")),
    ),
  );
  const menu = screen.getByRole("navigation", { name: "주 메뉴" });
  const links = within(menu).getAllByRole("link");
  expect(
    links.map((link) => new URL(link.getAttribute("href") ?? "", "http://localhost").pathname),
  ).toEqual([
    "/analysis/players",
    "/analysis/statistics",
    "/analysis/baserunning",
    "/analysis/park-environment",
    "/replay",
    "/analysis/coverage",
    "/analysis/models",
  ]);
  expect(within(menu).getByRole("heading", { name: "선수", exact: true })).toBeTruthy();
  expect(within(menu).getByRole("link", { name: "선수 분석" }).getAttribute("aria-current")).toBe(
    "page",
  );
  const button = screen.getByRole("button", { name: "메뉴" });
  await user.click(button);
  await user.click(within(menu).getByRole("link", { name: "선수 분석" }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(screen.getByRole("main"));
  await user.click(button);
  await user.tab();
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await user.click(button);
  fireEvent.pointerDown(screen.getByRole("heading", { name: "분석 본문" }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

it("lets keyboard users skip the navigation to the main content", async () => {
  const user = userEvent.setup();
  render(createElement(MemoryRouter, null, createElement(AppShell)));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "본문으로 건너뛰기" }));
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("main"));
});

function Tabs() {
  const [active, setActive] = useState("first");
  return createElement(WorkspaceTabs, {
    activeTab: active,
    ariaLabel: "작업 분류",
    idPrefix: "test",
    onChange: setActive,
    tabs: [
      { id: "first", label: "첫째", count: 1 },
      { id: "second", label: "둘째", count: 2 },
      { id: "third", label: "셋째", count: 3 },
    ],
  });
}
it("uses one tab stop and supports wrapping arrows and Home/End in workspace tabs", async () => {
  const user = userEvent.setup();
  render(createElement(Tabs));
  await user.tab();
  await user.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "셋째 3", selected: true }));
  await user.keyboard("{ArrowRight}{End}{Home}");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "첫째 1", selected: true }));
  expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
});

function List() {
  const [selected, setSelected] = useState<string | null>(null);
  return createElement(SelectableVirtualList<string>, {
    ariaLabel: "경기 선택",
    emptyMessage: "없음",
    items: ["first", "second", "third"],
    getKey: (item) => item,
    selectedKey: selected,
    onSelect: setSelected,
    renderItem: (item) => item,
    rowHeight: 50,
  });
}
it("starts on the first list row and keeps a single keyboard focus target", async () => {
  const user = userEvent.setup();
  render(createElement(List));
  await user.tab();
  const list = screen.getByRole("listbox");
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "first" }).getAttribute("aria-selected")).toBe("true");
  await user.keyboard("{End}");
  expect(list.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "third" }).id,
  );
  expect(screen.getAllByRole("option").every((option) => option.tabIndex === -1)).toBe(true);
  await user.click(screen.getByRole("option", { name: "second" }));
  expect(document.activeElement).toBe(list);
});

function Console() {
  const [selected, setSelected] = useState(false);
  return createElement(OperationConsole, {
    selected,
    onBack: () => setSelected(false),
    master: createElement("button", { onClick: () => setSelected(true) }, "경기 열기"),
    detail: createElement("h2", null, "경기 상세"),
  });
}
it("moves focus out of hidden mobile list/detail panels and restores the initiating control", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const user = userEvent.setup();
  render(createElement(Console));
  const open = screen.getByRole("button", { name: "경기 열기" });
  await user.click(open);
  const back = screen.getByRole("button", { name: "← 목록으로" });
  expect(document.activeElement).toBe(back);
  await user.click(back);
  expect(document.activeElement).toBe(open);
});
