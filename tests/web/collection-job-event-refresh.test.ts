import { describe, expect, it } from "vitest";

import type { JobEvent } from "@kbo/contracts";

import {
  collectionRefreshTargets,
  decodeCollectionJobEvent,
} from "../../apps/web/src/collection/job-event-refresh.js";

describe("collection job event refresh", () => {
  it("staging batch progress는 작업 목록만 갱신한다", () => {
    expect(collectionRefreshTargets(jobEvent("progress", "none"))).toEqual(["collectionJobs"]);
    expect(collectionRefreshTargets(jobEvent("game_completed", "none"))).toEqual([
      "collectionJobs",
    ]);
  });

  it("실제 저장 결과와 terminal event는 catalog와 dashboard도 갱신한다", () => {
    expect(collectionRefreshTargets(jobEvent("game_completed", "quarantined"))).toEqual([
      "collectionJobs",
      "catalog",
      "dashboard",
    ]);
    expect(collectionRefreshTargets(jobEvent("succeeded", "none"))).toEqual([
      "collectionJobs",
      "catalog",
      "dashboard",
    ]);
  });

  it("SSE JSON을 strict JobEvent 계약으로 decode한다", () => {
    const event = jobEvent("progress", "none");
    expect(decodeCollectionJobEvent(JSON.stringify(event))).toEqual(event);
    expect(() => decodeCollectionJobEvent('{"type":"progress"}')).toThrow();
    expect(() => decodeCollectionJobEvent("not-json")).toThrow();
  });
});

function jobEvent(
  type: JobEvent["type"],
  disposition: JobEvent["payload"]["disposition"],
): JobEvent {
  return {
    eventId: "job-1:1",
    jobId: "job-1",
    sequence: 1,
    occurredAt: "2026-08-29T00:00:00.000Z",
    type,
    payload: {
      message: "test",
      gameId: null,
      disposition,
      completedItems: 2,
      totalItems: 10,
    },
  };
}
