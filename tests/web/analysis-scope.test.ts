// @vitest-environment jsdom
import { createElement, type PropsWithChildren } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  changeAnalysisParams,
  scopeFromParams,
} from "../../apps/web/src/analysis/analysis-scope.js";
import { useAnalysisScope } from "../../apps/web/src/analysis/use-analysis-scope.js";

afterEach(cleanup);

it("restores URL scope through history and resets only season-dependent selections", () => {
  const initial = "/?season=2024&dateFrom=2024-04-01&dateTo=2024-07-31&pitcher=p&batter=b&balls=2";
  const { result } = renderHook(
    () => ({
      ...useAnalysisScope({ seasonSelectionKeys: ["pitcher"], throughSeasonEnd: true }),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    {
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(MemoryRouter, { initialEntries: [initial] }, children),
    },
  );
  expect(result.current.scope.options).toEqual({
    competition: "regular",
    dateFrom: "2024-04-01",
    dateTo: "2024-07-31",
  });
  expect(result.current.location.search).not.toContain("competition");
  act(() => result.current.change("season", "2025"));
  expect(result.current.location.search).toBe("?season=2025&batter=b&balls=2");
  expect(result.current.scope.options).toEqual({ competition: "regular", dateTo: "2025-12-31" });
  expect(result.current.selected.get("dateTo")).toBe("2025-12-31");
  act(() => result.current.navigate(-1));
  expect(result.current.location.search).toBe(initial.slice(1));
  expect(result.current.season).toBe(2024);
  expect(result.current.scope.options.dateTo).toBe("2024-07-31");
});

it("preserves explicit scope choices and leaves legacy default resolution separate", () => {
  const params = new URLSearchParams(
    "season=2024&competition=all&pitcher=p&batter=b&pitchType=직구",
  );
  const next = changeAnalysisParams(params, "season", "2025", ["pitcher", "batter"]);
  expect(Object.fromEntries(next)).toEqual({
    season: "2025",
    competition: "all",
    pitchType: "직구",
  });
  expect(params.get("pitcher")).toBe("p");
  expect(scopeFromParams(2024, new URLSearchParams())).toEqual({ options: {}, error: null });
  expect(changeAnalysisParams(params, "pitchType", "").has("pitchType")).toBe(false);
});

it.each([
  "dateFrom=2024-02-30",
  "dateFrom=2023-12-31",
  "dateFrom=2024-08-01&dateTo=2024-07-31",
  "competition=unsupported",
  "competition=",
])("keeps invalid URL scope visible and ineligible for requests: %s", (query) => {
  const { result } = renderHook(() => useAnalysisScope(), {
    wrapper: ({ children }: PropsWithChildren) =>
      createElement(MemoryRouter, { initialEntries: [`/?season=2024&${query}`] }, children),
  });
  expect(result.current.scope.error).not.toBeNull();
  expect(result.current.scope.options).toEqual({});
  expect(result.current.params.toString()).toBe(`season=2024&${query}`);
});
