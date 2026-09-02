import { ImportReadyBatchCreatedSchema, ImportReadyBatchCreateRequestSchema } from "@kbo/contracts";
import { describe, expect, it } from "vitest";

import { Value } from "@sinclair/typebox/value";

describe("적재 가능 문서 일괄 등록 계약", () => {
  it("strict 요청과 경기별 job 응답만 허용한다", () => {
    expect(
      Value.Check(ImportReadyBatchCreateRequestSchema, {
        idempotencyKey: "anon-batch-key",
      }),
    ).toBe(true);
    expect(
      Value.Check(ImportReadyBatchCreateRequestSchema, {
        idempotencyKey: "anon-batch-key",
        gameIds: ["추가 필드는 허용하지 않음"],
      }),
    ).toBe(false);
    expect(
      Value.Check(ImportReadyBatchCreatedSchema, {
        batchId: "anon-batch-1",
        createdCount: 1,
        skippedCount: 2,
        jobs: [{ jobId: "anon-job-1", gameId: "anon-game-1", status: "queued" }],
      }),
    ).toBe(true);
  });
});
