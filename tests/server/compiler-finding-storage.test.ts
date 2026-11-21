import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { StoredFinding } from "@kbo/contracts";
import { compileStagingGameDocumentV2, type Finding } from "@kbo/game-core";
import { StagingWorkspace } from "@kbo/persistence";
import { describe, expect, it } from "vitest";

import { mergePersistentSourceFindings } from "../../apps/server/src/correction-snapshot.js";
import { projectNaverSourceBundle } from "../../apps/server/src/source-projection.js";
import { sanitizedNaverBundle } from "../helpers/naver.js";

const findings: readonly Finding[] = [
  {
    gameId: "20260715AABB0",
    code: "domain.fixture.invalid_start",
    category: "domain",
    severity: "blocking",
    message: "Invalid fixture start",
    eventId: "20260715AABB0:relay_001:0:0",
    eventSequence: 0,
    recordIdentity: "start:1",
    details: [
      { field: "outs", expected: 0, actual: 1 },
      { field: "basesLoaded", expected: false, actual: null },
    ],
  },
  {
    gameId: "20260715AABB0",
    code: "source.fixture.warning",
    category: "source",
    severity: "warning",
    message: "Fixture warning",
    details: [],
  },
];

const expectedStored: readonly StoredFinding[] = [
  {
    producer: "compiler",
    lifecycle: "recomputed",
    code: "domain.fixture.invalid_start",
    category: "domain",
    severity: "blocking",
    message: "Invalid fixture start",
    eventId: "20260715AABB0:relay_001:0:0",
    eventSequence: 0,
    recordIdentity: "start:1",
    details: [
      { field: "outs", expected: 0, actual: 1 },
      { field: "basesLoaded", expected: false, actual: null },
    ],
  },
  {
    producer: "compiler",
    lifecycle: "recomputed",
    code: "source.fixture.warning",
    category: "source",
    severity: "warning",
    message: "Fixture warning",
  },
];

describe("컴파일러 검증 결과 저장", () => {
  it("수집과 교정 모두 완전히 같은 결과만 제거하고 다른 출처 행은 보존한다", async () => {
    const bundle = await sanitizedNaverBundle();
    const note = {
      lifecycle: "persistent",
      code: "source.fixture.observation",
      severity: "warning",
      message: "Fixture observation",
      endpoint: "relay_001",
      rowIndex: 1,
    } as const;
    const projected = projectNaverSourceBundle(bundle, null, [
      note,
      { ...note },
      { ...note, rowIndex: 2 },
    ]);
    const expected = [1, 2].map((rowIndex) => ({
      producer: "collection",
      lifecycle: "persistent",
      code: "source.fixture.observation",
      category: "source",
      severity: "warning",
      message: "Fixture observation",
      endpoint: "relay_001",
      details: [{ field: "source_row_index", actual: rowIndex }],
    }));
    expect(projected.findings).toStrictEqual(expected);
    expect(
      mergePersistentSourceFindings(
        [...projected.findings, ...projected.findings],
        [],
        projected.document,
      ),
    ).toStrictEqual(expected);
  });

  it("최초 수집은 순번이 다른 첫 투구의 검증 결과와 출처를 저장용으로 변환한다", async () => {
    const bundle = await sanitizedNaverBundle();
    const relay = bundle.payloads.relay_001 as {
      result: {
        textRelayData: { textRelays: Array<{ ptsOptions?: Array<{ ballcount: number }> }> };
      };
    };
    const tracking = relay.result.textRelayData.textRelays[0]?.ptsOptions?.[0];
    if (tracking === undefined) throw new Error("첫 번째 투구 트래킹 fixture 필요");
    tracking.ballcount = 7;

    expect(projectNaverSourceBundle(bundle, null).findings).toStrictEqual([
      {
        producer: "compiler",
        lifecycle: "recomputed",
        code: "source.tracking.ordinal_differs_from_actual_pitch",
        category: "source",
        severity: "warning",
        message:
          "PTS 투구 순번이 compiler의 실제 투구 순번과 다릅니다. 분석에는 compiler 순번을 사용합니다.",
        eventId: "20260715AABB0:relay_001:0:2",
        eventSequence: 2,
        recordIdentity: "20260715AABB0:relay_001:0:0",
        details: [{ field: "sourcePitchOrdinal", expected: 1, actual: 7 }],
      },
    ]);
  });

  it("교정 재검증은 영구 보존 결과에 현재 컴파일러 결과를 한 번씩 병합한다", async () => {
    const { document } = projectNaverSourceBundle(await sanitizedNaverBundle(), null);
    const persistent: StoredFinding = {
      producer: "collection",
      lifecycle: "persistent",
      code: "source.fixture.note",
      category: "source",
      severity: "warning",
      message: "Source note",
      endpoint: "relay_001",
    };
    const obsolete: StoredFinding = {
      ...persistent,
      producer: "compiler",
      lifecycle: "recomputed",
      code: "source.fixture.obsolete",
    };

    expect(
      mergePersistentSourceFindings([persistent, obsolete], [...findings, ...findings], document),
    ).toStrictEqual([persistent, ...expectedStored]);
  });

  it("봉인본에서 연 초안의 차단 결과는 현재 원장과 최초 원장에 같은 필드로 저장된다", async () => {
    const { document } = projectNaverSourceBundle(await sanitizedNaverBundle(), {
      revision: 1,
      documentHash: "a".repeat(64),
      sourceBundleHash: "b".repeat(64),
    });
    const replay = compileStagingGameDocumentV2(document);
    await using temporary = await mkdtempDisposable(path.join(tmpdir(), "kbo-compiler-findings-"));
    const workspace = await StagingWorkspace.open(temporary.path, undefined, async () => ({
      ...replay,
      findings,
    }));
    try {
      await workspace.saveCorrectionDraft(document);
      const { gameId, season } = document.metadata;
      expect(await workspace.readCurrentDocumentSnapshot(gameId)).toStrictEqual({
        authority: "quarantine",
        season,
        document,
        findings: expectedStored,
      });
      expect(await workspace.readOriginalFindings(season, gameId)).toStrictEqual(expectedStored);
    } finally {
      await workspace.close();
    }
  });
});
