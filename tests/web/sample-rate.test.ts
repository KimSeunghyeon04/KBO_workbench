// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SampleRate } from "../../apps/web/src/analysis/sample-rate.js";
afterEach(cleanup);
it("distinguishes sparse observed zero from supported zero and a missing denominator", () => {
  const view = render(
    createElement(SampleRate, { value: 0, numerator: 0, denominator: 5, unit: "스윙" }),
  );
  expect(screen.getByText("0.0%")).toBeTruthy();
  expect(screen.getByText("0/5 스윙")).toBeTruthy();
  expect(screen.getByText(/소표본/)).toBeTruthy();
  view.rerender(
    createElement(SampleRate, { value: 0, numerator: 0, denominator: 500, unit: "스윙" }),
  );
  expect(screen.queryByText(/소표본/)).toBeNull();
  view.rerender(
    createElement(SampleRate, { value: null, numerator: 0, denominator: 0, unit: "스윙" }),
  );
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.queryByText("0.0%")).toBeNull();
});
