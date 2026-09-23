import {
  KBO_RECORD_CORRECTION_FIRST_SEASON,
  type KboRecordCorrectionCollector,
} from "@kbo/collection";
import type { RecordCorrectionJob } from "@kbo/contracts";
import type { RecordCorrectionRepository } from "@kbo/persistence";
import { expect, it, vi } from "vitest";

import { RecordCorrectionJobManager } from "../../apps/server/src/jobs/record-correction-job-manager.js";

const now = "2026-09-23T00:00:00.000Z";

function setup(sealedSeasons: number[]) {
  const job: RecordCorrectionJob = {
    jobId: "fixture-record-job",
    status: "queued",
    trigger: "manual",
    seasons: [],
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    completedSeasons: 0,
    totalSeasons: 0,
    error: null,
  };
  const unused = async (): Promise<never> => {
    throw new Error("이 회귀에서 호출하면 안 되는 저장소 경로입니다.");
  };
  const repository = {
    resumableJobs: unused,
    summary: unused,
    seasonsWithSealedGames: vi.fn(async () => sealedSeasons),
    createJob: vi.fn<RecordCorrectionRepository["createJob"]>(
      async (_jobId, trigger, _key, seasons) => {
        job.trigger = trigger;
        job.seasons = [...seasons];
        job.totalSeasons = seasons.length;
        return { created: true, job };
      },
    ),
    job: vi.fn(async () => job),
    jobs: unused,
    setJobCancelling: unused,
    setJobRunning: vi.fn(async () => undefined),
    markSeasonRunning: vi.fn(async () => undefined),
    importSeason: vi.fn<RecordCorrectionRepository["importSeason"]>(async (_jobId, dataset) => ({
      season: dataset.season,
      revision: 1,
      sourceBundleHash: "a".repeat(64),
      noticeCount: 0,
      noChange: true,
    })),
    seasonHasPendingAssessments: vi.fn(async () => false),
    finishJob: vi.fn(async () => undefined),
    markSeasonFailed: vi.fn(async () => undefined),
  };
  const collect = vi.fn<KboRecordCorrectionCollector["collect"]>(async ({ season }) => {
    if (season < KBO_RECORD_CORRECTION_FIRST_SEASON)
      throw new Error(`KBO 기록정정 control에 ${String(season)} 시즌이 없습니다.`);
    return {
      dataset: { season, collectedAt: now, sourcePages: [], notices: [] },
      sourceBundleHash: "a".repeat(64),
    };
  });
  const manager = new RecordCorrectionJobManager(
    { collect },
    repository,
    { assessSeason: unused },
    "unused-fixture-workspace",
    { enabled: false, syncIntervalMs: 86_400_000, retryIntervalMs: 21_600_000 },
    () => new Date(now),
    () => job.jobId,
  );
  return { manager, repository, collect };
}

it.each(["manual", "scheduled"] as const)(
  "%s 기본 동기화는 공식 공지 서비스 시작 이후의 보유 시즌만 수집한다",
  async (trigger) => {
    const sealedSeasons = [2025, 2020, 2023, 2021, 2022, 2024];
    const { manager, repository, collect } = setup(sealedSeasons);
    try {
      await manager.create({ idempotencyKey: "default-fixture" }, trigger);
      await vi.waitFor(() => expect(repository.finishJob).toHaveBeenCalled());
      expect(repository.createJob).toHaveBeenCalledWith(
        "fixture-record-job",
        trigger,
        "default-fixture",
        [2022, 2023, 2024, 2025],
        now,
      );
      expect(collect.mock.calls.map(([options]) => options.season)).toEqual([
        2022, 2023, 2024, 2025,
      ]);
      expect(repository.finishJob).toHaveBeenCalledWith("fixture-record-job", "no_change", now);
      expect(sealedSeasons).toEqual([2025, 2020, 2023, 2021, 2022, 2024]);
    } finally {
      await manager.close();
    }
  },
);

it("명시한 제도 이전 시즌은 제외하지 않고 기존 source 거부 결과를 전달한다", async () => {
  const { manager, repository, collect } = setup([2020, 2022]);
  try {
    await manager.create({ idempotencyKey: "explicit-fixture", seasons: [2020] });
    await vi.waitFor(() => expect(repository.finishJob).toHaveBeenCalled());
    expect(repository.seasonsWithSealedGames).not.toHaveBeenCalled();
    expect(collect.mock.calls.map(([options]) => options.season)).toEqual([2020]);
    expect(repository.importSeason).not.toHaveBeenCalled();
    expect(repository.finishJob).toHaveBeenCalledWith(
      "fixture-record-job",
      "failed",
      now,
      "source",
      "KBO 기록정정 control에 2020 시즌이 없습니다.",
    );
  } finally {
    await manager.close();
  }
});

it("제도 이전 경기만 보유한 경우 빈 정상 job을 만들지 않는다", async () => {
  const { manager, repository, collect } = setup([2020, 2021]);
  try {
    await expect(manager.create({ idempotencyKey: "unsupported-fixture" })).rejects.toThrow(
      "공식 기록정정 조회 범위에 해당하는 sealed 경기가 없습니다.",
    );
    expect(repository.createJob).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  } finally {
    await manager.close();
  }
});
