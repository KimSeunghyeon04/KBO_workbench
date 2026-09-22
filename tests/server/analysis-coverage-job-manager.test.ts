import { expect, it, vi } from "vitest";
import type { CoverageInspection } from "@kbo/persistence";
import { AnalysisCoverageJobManager } from "../../apps/server/src/jobs/analysis-coverage-job-manager.js";
const inspection = (key: string): CoverageInspection => ({
  sourceKey: key,
  scope: { season: 2025, competition: "all", dateFrom: null, dateTo: null },
  response: null,
});

it("coalesces same-source date filters, bounds the queue and drains on close", async () => {
  const prepare = vi.fn(
    async (_value: CoverageInspection, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const jobs = new AnalysisCoverageJobManager(prepare, vi.fn());
  jobs.ensure(inspection("a"));
  jobs.ensure({ ...inspection("a"), scope: { ...inspection("a").scope, dateFrom: "2025-06-01" } });
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 16; i++) jobs.ensure(inspection(String(i)));
  expect(() => jobs.ensure(inspection("overflow"))).toThrow("많습니다");
  await jobs.close();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(() => jobs.ensure(inspection("closed"))).toThrow("종료");
});

it("retains failures until explicit retry while new source keys can proceed", async () => {
  const prepare = vi.fn(async () => {
    throw new Error("offline");
  });
  const report = vi.fn();
  const jobs = new AnalysisCoverageJobManager(prepare, report);
  jobs.ensure(inspection("a"));
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(jobs.ensure(inspection("a")).state).toBe("failed");
  expect(prepare).toHaveBeenCalledTimes(1);
  jobs.ensure(inspection("b"));
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
  expect(jobs.ensure(inspection("a"), true).state).toBe("preparing");
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
  await jobs.close();
});
