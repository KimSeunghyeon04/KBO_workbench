import { describe, expect, it } from "vitest";

import {
  decodeRelayRows,
  prepareRelayBlocks,
} from "../../packages/collection/src/naver/source-pipeline.js";
import type { RelayBlockInput } from "../../packages/collection/src/naver/model.js";

describe("Naver 원천 정리 파이프라인 원칙", () => {
  it("의미가 같은 반복 행도 원천 위치별 행으로 모두 보존한다", () => {
    const decoded = decodeRelayRows(
      prepareRelayBlocks([
        block([
          { seqno: 0, kind: "batter_start", text: "원정1 타석", batterId: "a1", pitcherId: "hp1" },
          { seqno: 1, kind: "batter_start", text: "원정1 타석", batterId: "a1", pitcherId: "hp1" },
        ]),
      ]),
    );
    expect(decoded).toHaveLength(2);
    expect(decoded.map((row) => row.rawIndex)).toEqual([0, 1]);
    expect(decoded[0]?.semanticFingerprint).toBe(decoded[1]?.semanticFingerprint);
  });

  it("JSON 필드 순서와 저장하지 않는 cosmetic 필드는 fingerprint를 바꾸지 않는다", () => {
    const rows = decodeRelayRows(
      prepareRelayBlocks([
        block([
          {
            seqno: 0,
            kind: "pitch",
            text: "1구 볼",
            call: "ball",
            ptsPitchId: "p1",
            batterId: "a1",
            pitcherId: "hp1",
            displayColor: "red",
          },
          {
            pitcherId: "hp1",
            batterId: "a1",
            ptsPitchId: "p1",
            call: "ball",
            text: "1구 볼",
            kind: "pitch",
            seqno: 1,
            displayColor: "blue",
          },
        ]),
      ]),
    );
    expect(rows[0]?.semanticFingerprint).toBe(rows[1]?.semanticFingerprint);
    expect(rows).toHaveLength(2);
  });
});

function block(rows: readonly Readonly<Record<string, unknown>>[]): RelayBlockInput {
  return {
    endpoint: "relay_001",
    endpointBlockIndex: 0,
    block: { inn: 1, homeOrAway: "0", textOptions: rows },
  };
}
