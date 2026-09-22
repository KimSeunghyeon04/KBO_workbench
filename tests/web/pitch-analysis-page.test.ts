// @vitest-environment jsdom

import { resolveAnalysisScope } from "@kbo/contracts";
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PITCH_CLUSTER_PARAMETERS, type PitchAnalysisResponse } from "@kbo/contracts";
import {
  classifyPitchReference,
  fitPitchReferenceDistribution,
  summarizePitchExpectation,
  summarizePitchQuality,
} from "@kbo/game-core";
import { PitchAnalysisPage } from "../../apps/web/src/pages/pitch-analysis-page.js";
import { getPitchAnalysis } from "../../apps/web/src/api/pitch-analysis-client.js";
import { calibrationSummary } from "../helpers/pitch-calibration.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(season: number, pitcherId: string, k = 2): PitchAnalysisResponse {
  const result: PitchAnalysisResponse = {
    referenceDistribution: null,
    expectation: { modelVersion: 1, providerGroups: [], clusterGroups: [], bands: [] },
    modelVersion: 2,
    calibration: calibrationSummary(2),
    season,
    scope: resolveAnalysisScope({ season }),
    pitcherId,
    sourceHash: "a".repeat(64),
    referenceSourceHash: "a".repeat(64),
    profile: { groups: [], months: [] },
    clustering: {
      ...PITCH_CLUSTER_PARAMETERS,
      defaultClusterCount: 2,
      maxClusterCount: 2,
      componentCount: k,
      clusterCount: k,
      unassignedCount: 0,
      iterations: 5,
      status: "ready",
    },
    baseline: {
      pitchType: "직구",
      candidateCount: 100,
      sampleCount: 99,
      excludedCount: 1,
      arrivalMs: season === 2024 ? 400 : 380,
      speedKphAt50Feet: 140,
      firstGameDate: `${season}-04-01`,
      lastGameDate: `${season}-09-30`,
    },
    actualPitchCount: 4,
    missingTrackingCount: 1,
    invalidTrackingCount: 1,
    points: ["직구", "슬라이더"].map((pitchType, index) => ({
      gameId: `game-${season}`,
      revision: 1,
      pitchId: `p${index}`,
      trackingId: `t${index}`,
      gameDate: `${season}-06-01`,
      stadium: null,
      calibrationStatus: "insufficient_data",
      calibrationXcm: null,
      calibrationZcm: null,
      pitchType,
      clusterId: k === 1 ? 1 : index + 1,
      speedKph: 140 - 15 * index,
      xCm: 12 * index,
      zCm: -18 * index,
      arrivalMs: 370 + 35 * index,
      timingDifferenceMs: -10 + 35 * index,
      distanceToPlateCm: -130 + 455 * index,
      extrapolated: index === 0,
      swing: true,
      whiff: index === 1,
      referenceBand: null,
    })),
  };
  result.expectation = summarizePitchExpectation(result.points, null);
  return result;
}

describe("투구 움직임 화면", () => {
  it("보정된 구수와 선택한 투구의 구장·차감량을 표시한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const data = response(2025, "hp1");
    data.calibration = calibrationSummary(2, 1);
    const point = data.points[0];
    if (point === undefined) throw new Error("Missing fixture point");
    Object.assign(point, {
      stadium: "잠실",
      calibrationStatus: "applied",
      calibrationXcm: 1.2,
      calibrationZcm: -0.4,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request) =>
          new Response(
            JSON.stringify(
              String(input).includes("/hp1?")
                ? data
                : {
                    season: 2025,
                    scope: resolveAnalysisScope({ season: 2025 }),
                    pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }],
                  },
            ),
          ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    const chart = await screen.findByRole("img");
    expect(screen.getByLabelText("구장 보정 현황").textContent).toContain("구장 보정 1구");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(
      within(screen.getByRole("region", { name: "선택한 투구" })).getByText(/잠실 · 구장 보정 적용/)
        .textContent,
    ).toContain("좌우 +1.2 cm, 높이 -0.4 cm 차감");
    client.clear();
  });
  it("보정 집계와 개별 투구의 보정 상태가 다르면 거부한다", async () => {
    for (const mutate of [
      (data: PitchAnalysisResponse) => {
        data.calibration.calibratedCount = 1;
      },
      (data: PitchAnalysisResponse) => {
        const p = data.points[0];
        if (p !== undefined) p.calibrationXcm = 3;
      },
    ]) {
      const data = response(2024, "hp1");
      mutate(data);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(data))),
      );
      await expect(getPitchAnalysis(2024, "hp1", new AbortController().signal)).rejects.toThrow(
        "구장 보정 집계",
      );
    }
  });
  it("투구 결과와 맞지 않는 헛스윙률·영역·누락 필드를 응답 경계에서 거부한다", async () => {
    for (const mutate of [
      (data: PitchAnalysisResponse) => {
        const g = data.expectation.providerGroups[0];
        if (g !== undefined) g.whiffRate = 0.25;
      },
      (data: PitchAnalysisResponse) => {
        const p = data.points[0];
        if (p !== undefined) p.referenceBand = "outside90";
      },
      (data: PitchAnalysisResponse) => {
        data.expectation.providerGroups = [];
      },
    ]) {
      const data = response(2024, "hp1");
      mutate(data);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(data))),
      );
      await expect(getPitchAnalysis(2024, "hp1", new AbortController().signal)).rejects.toThrow(
        "포심 비교 집계",
      );
    }
    const data = response(2024, "hp1");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...data,
              points: data.points.map((p) => ({ ...p, whiff: undefined })),
            }),
          ),
      ),
    );
    await expect(getPitchAnalysis(2024, "hp1", new AbortController().signal)).rejects.toThrow();
  });
  it("포심 분포 표시를 전환하고 구종·군집별 분모와 전체 분포 비교를 유지한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const data = response(2024, "hp1");
    data.referenceDistribution = fitPitchReferenceDistribution(
      Array.from({ length: 99 }, (_, i) => ({
        xCm: (i - 49) * 0.4,
        distanceToPlateCm: Math.sin(i) * 180,
        zCm: Math.cos(i) * 15,
      })),
    );
    data.points = data.points.map((p, i) => ({
      ...p,
      swing: i === 1,
      referenceBand: classifyPitchReference(p, data.referenceDistribution),
    }));
    data.expectation = summarizePitchExpectation(data.points, data.referenceDistribution);
    const fetcher = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).includes("/hp1?")
              ? data
              : {
                  season: 2024,
                  scope: resolveAnalysisScope({ season: 2024 }),
                  pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/pitch-shape?season=2024"] },
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    const panel = await screen.findByRole("region", { name: "포심 기대와의 차이" });
    const table = within(panel).getByRole("table");
    expect(within(table).getByText("100.0%", { selector: "strong" })).toBeTruthy();
    expect(within(table).getByText("0 / 0 스윙")).toBeTruthy();
    const toggle = screen.getByRole("checkbox", { name: "시즌 포심 분포 표시" });
    expect(toggle).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("좌우 회전"), { target: { value: "70" } });
    await user.click(toggle);
    expect(toggle).toHaveProperty("checked", false);
    expect(screen.getByLabelText("좌우 회전")).toHaveProperty("value", "70");
    const calls = fetcher.mock.calls.length;
    await user.selectOptions(screen.getByLabelText("분석 구종"), "직구");
    expect(within(table).queryByText("슬라이더")).toBeNull();
    expect(panel.querySelectorAll(".pitch-expectation-bands > div")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "클러스터링 기준" }));
    expect(within(table).getByText("클러스터 2")).toBeTruthy();
    expect(toggle).toHaveProperty("checked", false);
    expect(fetcher.mock.calls).toHaveLength(calls);
    expect(within(panel).getByText(/코스·카운트·타자 좌우를 보정하지/)).toBeTruthy();
    client.clear();
  });
  it("잘못된 URL 군집 수는 요청하지 않고 초기화로 복구한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const fetcher = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).includes("/hp1?")
              ? response(2024, "hp1")
              : {
                  season: 2024,
                  scope: resolveAnalysisScope({ season: 2024 }),
                  pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/pitch-shape?season=2024&pitcher=hp1&color=cluster&clusterCount=bad",
          ],
        },
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("양의 정수"),
    );
    expect(screen.getByRole("button", { name: "새로 계산" })).toHaveProperty("disabled", true);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("/hp1?"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "중계 구종 수로 초기화" }));
    expect(await screen.findByLabelText("군집 수")).toHaveProperty("value", "2");
    expect(screen.queryByRole("alert")).toBeNull();
    client.clear();
  });
  it("군집 수를 즉시 바꾸고 응답 역전에도 최신 결과·시점·선택 투구를 유지하며 기본값을 복원한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let finishOne: (() => void) | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      const season = Number(url.searchParams.get("season"));
      if (url.pathname.endsWith("/pitch-shape"))
        return new Response(
          JSON.stringify({
            season,
            scope: resolveAnalysisScope({ season }),
            pitchers: [
              { pitcherId: "hp1", name: "투수 A", pitches: 4 },
              { pitcherId: "hp2", name: "투수 B", pitches: 4 },
            ],
          }),
        );
      const k = Number(url.searchParams.get("clusterCount") ?? 2);
      if (k === 1)
        await new Promise<void>((resolve) => {
          finishOne = resolve;
        });
      return new Response(
        JSON.stringify(response(season, url.pathname.split("/").at(-1) ?? "hp1", k)),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/pitch-shape?season=2024&pitcher=hp1&color=cluster"] },
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    expect(await screen.findByLabelText("군집 수")).toHaveProperty("value", "2");
    expect(screen.getByRole("button", { name: "중계 구종 수로 초기화" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(screen.getByLabelText("좌우 회전"), { target: { value: "70" } });
    fireEvent.keyDown(screen.getByRole("img"), { key: "Home" });
    await user.selectOptions(screen.getByLabelText("분석 클러스터"), "클러스터 1");
    fireEvent.keyDown(screen.getByRole("img"), { key: "Home" });
    await user.selectOptions(screen.getByLabelText("군집 수"), "1");
    expect(await screen.findByText(/1개 군집으로 GMM 계산 중/)).toBeTruthy();
    expect(screen.getByLabelText("분석 클러스터")).toHaveProperty("value", "");
    expect(screen.getByLabelText("좌우 회전")).toHaveProperty("value", "70");
    await user.selectOptions(screen.getByLabelText("군집 수"), "2");
    await waitFor(() => expect(screen.queryByText(/GMM 계산 중/)).toBeNull());
    await act(async () => {
      finishOne?.();
      await Promise.resolve();
    });
    expect(screen.getByLabelText("군집 수")).toHaveProperty("value", "2");
    expect(screen.getByText(/GMM 설정 2개/)).toBeTruthy();
    expect(screen.getByLabelText("좌우 회전")).toHaveProperty("value", "70");
    expect(
      within(screen.getByRole("region", { name: "선택한 투구" })).getByText("직구"),
    ).toBeTruthy();
    const calls = fetcher.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "중계 표기 기준" }));
    await user.click(screen.getByRole("button", { name: "클러스터링 기준" }));
    expect(fetcher.mock.calls).toHaveLength(calls);
    expect(screen.getByRole("button", { name: "중계 구종 수로 초기화" })).toHaveProperty(
      "disabled",
      false,
    );
    await user.click(screen.getByRole("button", { name: "중계 구종 수로 초기화" }));
    expect(screen.getByRole("button", { name: "중계 구종 수로 초기화" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.selectOptions(screen.getByLabelText("군집 수"), "2");
    await user.selectOptions(screen.getByLabelText("분석 투수"), "hp2");
    expect(await screen.findByLabelText("군집 수")).toHaveProperty("value", "2");
    expect(screen.getByRole("button", { name: "중계 구종 수로 초기화" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.selectOptions(screen.getByLabelText("군집 수"), "2");
    await user.selectOptions(screen.getByLabelText("분석 시즌"), "2025");
    await screen.findByText("380.0");
    expect(screen.getByRole("button", { name: "중계 구종 수로 초기화" })).toHaveProperty(
      "disabled",
      true,
    );
    client.clear();
  });

  it("URL의 군집 수를 복원하고 잘못된 응답의 군집 수를 거부한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const fetcher = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).includes("/hp1?")
              ? response(2024, "hp1", 1)
              : {
                  season: 2024,
                  scope: resolveAnalysisScope({ season: 2024 }),
                  pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }],
                },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            "/analysis/pitch-shape?season=2024&pitcher=hp1&color=cluster&clusterCount=1",
          ],
        },
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    expect(await screen.findByLabelText("군집 수")).toHaveProperty("value", "1");
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("clusterCount=1"))).toBe(true);
    await user.selectOptions(screen.getByLabelText("군집 수"), "2");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("분석 클러스터 집계"),
    );
    client.clear();
  });

  it("시즌 기준을 전환하고 구종 필터와 키보드 선택으로 위치·타이밍·외삽을 표시한다", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input), "http://localhost");
        const season = Number(url.searchParams.get("season"));
        const pitcherId = url.pathname.endsWith("/pitch-shape")
          ? null
          : url.pathname.split("/").at(-1);
        return new Response(
          JSON.stringify(
            pitcherId === null
              ? {
                  season,
                  scope: resolveAnalysisScope({ season }),
                  pitchers: [
                    { pitcherId: "hp1", name: "투수 A", pitches: 4 },
                    { pitcherId: "hp2", name: "투수 B", pitches: 3 },
                  ],
                }
              : response(season, pitcherId ?? "hp1"),
          ),
          { status: 200 },
        );
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/analysis/pitch-shape?season=2024"] },
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    expect(await screen.findByText("400.0")).toBeTruthy();
    expect(screen.getByLabelText("구장 보정 현황").textContent).toContain("미보정 2구");
    await user.click(screen.getByRole("button", { name: "클러스터링 기준" }));
    expect(screen.getByLabelText("분석 클러스터")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("분석 클러스터"), "클러스터 1");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("1개");
    await user.click(screen.getByRole("button", { name: "중계 표기 기준" }));
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("2개");
    fireEvent.change(screen.getByLabelText("좌우 회전"), { target: { value: "70" } });
    expect(screen.getByLabelText("좌우 회전")).toHaveProperty("value", "70");
    await user.click(screen.getByRole("button", { name: "정면" }));
    expect(screen.getByLabelText("좌우 회전")).toHaveProperty("value", "0");
    const chart = screen.getByRole("img");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(
      within(screen.getByRole("region", { name: "선택한 투구" })).getByText(
        "플레이트 통과 후 · 외삽",
      ),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("분석 구종"), "슬라이더");
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("1개");
    fireEvent.keyDown(screen.getByRole("img"), { key: "Home" });
    expect(
      within(screen.getByRole("region", { name: "선택한 투구" })).getByText("+25.0 ms"),
    ).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("분석 투수"), "hp2");
    expect(await screen.findByText("400.0")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("분석 시즌"), "2025");
    expect(await screen.findByText("380.0")).toBeTruthy();
    expect(screen.queryByText("400.0")).toBeNull();
    expect(screen.getByLabelText("분석 구종")).toHaveProperty("value", "");
    client.clear();
  });

  it("계산 가능한 기준 직구가 없으면 산점도를 만들지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request) =>
          new Response(
            JSON.stringify(
              String(input).includes("/hp1?")
                ? {
                    ...response(2025, "hp1"),
                    baseline: null,
                    expectation: {
                      modelVersion: 1,
                      providerGroups: [],
                      clusterGroups: [],
                      bands: [],
                    },
                    points: [],
                    calibration: calibrationSummary(0),
                    clustering: {
                      ...response(2025, "hp1").clustering,
                      clusterCount: 0,
                      componentCount: 0,
                      defaultClusterCount: 0,
                      maxClusterCount: 0,
                      unassignedCount: 0,
                      iterations: 0,
                      status: "empty",
                    },
                  }
                : {
                    season: 2025,
                    scope: resolveAnalysisScope({ season: 2025 }),
                    pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }],
                  },
            ),
            { status: 200 },
          ),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
      ),
    );
    expect(
      await screen.findByText("계산 가능한 직구가 없어 시즌 기준 궤적을 만들 수 없습니다."),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    client.clear();
  });
});

it("keeps the parent all-games scope when opening the quality panel", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const scope = resolveAnalysisScope({ season: 2025 }),
    quality = summarizePitchQuality([], scope, "hp1", "a".repeat(64), null, null);
  const fetch = vi.fn(async (input: string | URL | Request) =>
    Response.json(
      String(input).includes("pitch-quality")
        ? quality
        : String(input).includes("/hp1?")
          ? response(2025, "hp1")
          : { season: 2025, scope, pitchers: [{ pitcherId: "hp1", name: "투수 A", pitches: 4 }] },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      MemoryRouter,
      null,
      createElement(QueryClientProvider, { client }, createElement(PitchAnalysisPage)),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "구종 기대 효과 보기" }));
  expect(await screen.findByText("기대 확률은 확인된 정규시즌에서만 제공합니다.")).toBeTruthy();
  expect(
    fetch.mock.calls.some(([url]) =>
      String(url).includes("pitch-quality/hp1?season=2025&competition=all"),
    ),
  ).toBe(true);
  client.clear();
});
