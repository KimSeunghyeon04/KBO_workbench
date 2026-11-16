// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAnalysisScope } from "@kbo/contracts";
import { analyzePitchSequences } from "@kbo/game-core";
import { PitchSequencePairs } from "../../apps/web/src/analysis/pitch-sequence-pairs.js";
import { getPitchSequences } from "../../apps/web/src/api/pitch-sequence-client.js";
import { independentSequenceSamples, pitchSequenceRow } from "../helpers/pitch-sequence.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const query = { season: 2024 };
const scope = resolveAnalysisScope(query, "regular");

it("shows each mean's valid sample, missing means, and the distinct outcome denominators", () => {
  const data = analyzePitchSequences(query, "p", scope, "hash", [
    ...independentSequenceSamples(),
    pitchSequenceRow(6, { paId: "pa4", pitchType: "커브" }),
    pitchSequenceRow(7, {
      paId: "pa4",
      pitchType: "커브",
      trackingId: null,
      speedKph: null,
    }),
  ]);
  render(createElement(MemoryRouter, null, createElement(PitchSequencePairs, { data })));
  fireEvent.click(screen.getByText("조합별 상세 성적과 계산 기준"));
  const table = within(screen.getByRole("table", { name: "두 구종 조합" }));
  const measured = table.getByRole("row", { name: /직구 → 직구/ });
  expect(within(measured).getByText("66.7%")).toBeTruthy();
  expect(within(measured).getByText("50.0%")).toBeTruthy();
  expect(within(measured).getByText("33.3%")).toBeTruthy();
  expect(within(measured).getByRole("cell", { name: "+3.00 유효 2쌍" })).toBeTruthy();
  expect(within(measured).getByRole("cell", { name: "0.00 유효 1쌍" })).toBeTruthy();
  expect(within(measured).getAllByRole("cell", { name: "0.00 유효 2쌍" })).toHaveLength(2);
  const missing = table.getByRole("row", { name: /커브 → 커브/ });
  expect(within(missing).getAllByRole("cell", { name: "— 유효 0쌍" })).toHaveLength(4);
  expect(screen.getByText(/Swing%는 스윙\/쌍, Whiff%는 헛스윙\/스윙/)).toBeTruthy();
  expect(screen.getByText(/시간·구속 차는 두 번째−첫 번째/)).toBeTruthy();
  const second = screen.getAllByRole("button", { name: "궤적 비교" })[1];
  if (!second) throw new Error("Expected second comparison");
  fireEvent.click(second);
  expect(second.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("heading", { name: /선택 목록 2번째 쌍/ })).toBe(document.activeElement);
  expect(screen.getAllByRole("link", { name: /재생 r/ })[0]?.getAttribute("href")).toContain(
    "eventId=",
  );
});

it("decodes server-provided sample counts and rejects a response that omits one", async () => {
  const response = analyzePitchSequences(query, "p", scope, "hash", independentSequenceSamples());
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetch);
  expect(await getPitchSequences(query, "p", new AbortController().signal)).toEqual(response);
  const group = response.groups[0];
  if (group === undefined) throw new Error("Expected a sequence group");
  fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        ...response,
        groups: [
          Object.fromEntries(
            Object.entries(group).filter(([key]) => key !== "arrivalDistancePairs"),
          ),
        ],
      }),
    ),
  );
  await expect(getPitchSequences(query, "p", new AbortController().signal)).rejects.toThrow();
});

it("selects every group and resets pair navigation without losing missing tracking evidence", () => {
  const data = analyzePitchSequences(query, "p", scope, "hash", [
    ...independentSequenceSamples(),
    pitchSequenceRow(6, { paId: "pa4", pitchType: "커브" }),
    pitchSequenceRow(7, { paId: "pa4", pitchType: "커브", trackingId: null }),
  ]);
  render(createElement(MemoryRouter, null, createElement(PitchSequencePairs, { data })));
  expect(screen.getByRole("table", { name: "두 구종 조합" }).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "다음 쌍" }));
  expect(screen.getByRole("heading", { name: /선택 목록 2번째 쌍/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "비교할 조합" }), {
    target: { value: JSON.stringify(["커브", "커브"]) },
  });
  expect(screen.getByRole("heading", { name: /커브 → 커브 · 선택 목록 1번째 쌍/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "다음 쌍" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("일부 좌표가 누락");
  expect(screen.queryByRole("img", { name: "수평 궤적 비교" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "비교할 조합" }), {
    target: { value: "" },
  });
  expect(screen.getByText("4쌍 중 1번째")).toBeTruthy();
  expect(screen.getByRole("img", { name: "수평 궤적 비교" })).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /선택한 두 번째 공 재생/ }).getAttribute("href"),
  ).toContain("eventId=");
});
