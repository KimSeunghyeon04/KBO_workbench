import { describe, expect, it } from "vitest";

import { compileStagingGameDocumentV2 } from "@kbo/game-core";

import {
  loadedBasesWithTwoOuts,
  makeDocument,
  out,
  safe,
  scored,
} from "../helpers/game-document.js";

function resultWith(movements: readonly unknown[]) {
  return {
    kind: "plate_appearance_result",
    payload: {
      result: "single",
      batterId: "a6",
      pitcherId: "hp1",
      creditedRbi: 0,
      movements,
    },
  };
}

describe("제3아웃과 득점", () => {
  it("임시 베이스 적용 순서와 실제 아웃 순서를 분리해 타자 아웃 뒤 주자 태그아웃을 제3아웃으로 판정한다", () => {
    const oneOutLoaded = loadedBasesWithTwoOuts().slice(0, -3);
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...oneOutLoaded,
        { kind: "batter_start", payload: { batterId: "a5", pitcherId: "hp1" } },
        {
          kind: "plate_appearance_result",
          payload: {
            result: "field_out",
            batterId: "a5",
            pitcherId: "hp1",
            movements: [
              out("a5", 0, 1, 0, "batter_runner_before_first"),
              out("a2", 2, 3, 1, "tag"),
              scored("a1", 3, 2),
              safe("a3", 1, 2, 3),
            ],
          },
        },
      ]),
    );

    expect(replay.finalState.outs).toBe(3);
    expect(replay.finalState.awayScore).toBe(1);
    expect(replay.plays.at(-1)?.movements.map((movement) => movement.runnerId)).toEqual([
      "a1",
      "a2",
      "a3",
      "a5",
    ]);
    expect(replay.findings).toEqual([]);
  });

  it("제3아웃보다 먼저 홈을 밟은 time play 득점은 인정한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        resultWith([
          scored("a1", 3, 0),
          out("a2", 2, 3, 1, "tag"),
          safe("a3", 1, 2, 2),
          safe("a6", 0, 1, 3),
        ]),
      ]),
    );
    expect(replay.finalState.awayScore).toBe(1);
    expect(replay.finalState.outs).toBe(3);
    expect(replay.finalState.bases).toEqual([null, null, null]);
    expect(replay.findings).toEqual([]);
  });

  it("제3아웃이 force out이면 먼저 들어온 득점도 인정하지 않는다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        resultWith([
          scored("a1", 3, 0),
          out("a2", 2, 3, 1, "force"),
          safe("a3", 1, 2, 2),
          safe("a6", 0, 1, 3),
        ]),
      ]),
    );
    expect(replay.finalState.awayScore).toBe(0);
  });

  it("time-play 어필 아웃에서는 선행 주자만 득점한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        resultWith([
          scored("a1", 3, 0),
          scored("a3", 1, 1),
          out("a2", 2, 3, 2, "appeal_time"),
          safe("a6", 0, 1, 3),
        ]),
      ]),
    );
    expect(replay.finalState.awayScore).toBe(1);
  });

  it("수비가 선택한 apparent fourth out이 기존 제3아웃을 대체한다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        resultWith([
          scored("a1", 3, 0),
          out("a2", 2, 3, 1, "tag"),
          out("a3", 1, 2, 2, "appeal_force", true),
          safe("a6", 0, 1, 3),
        ]),
      ]),
    );
    expect(replay.finalState.awayScore).toBe(0);
    expect(replay.finalState.outs).toBe(3);
  });

  it("원래 제3아웃보다 앞선 out을 apparent fourth out으로 지정할 수 없다", () => {
    const replay = compileStagingGameDocumentV2(
      makeDocument([
        ...loadedBasesWithTwoOuts(),
        resultWith([
          out("a2", 2, 3, 0, "appeal_force", true),
          scored("a1", 3, 1),
          safe("a3", 1, 2, 2),
          safe("a6", 0, 1, 3),
        ]),
      ]),
    );
    expect(replay.frames.at(-1)?.applied).toBe(false);
    expect(replay.findings.map((finding) => finding.code)).toContain(
      "fourth_out_not_after_third_out",
    );
  });

  it("movement 하나가 잘못되면 play 전체를 rollback한다", () => {
    const specs = loadedBasesWithTwoOuts();
    const replay = compileStagingGameDocumentV2(
      makeDocument([...specs, resultWith([safe("a6", 0, 1, 0)])]),
    );
    const lastFrame = replay.frames.at(-1);
    expect(lastFrame?.applied).toBe(false);
    expect(lastFrame?.after).toEqual(lastFrame?.before);
    expect(replay.findings.some((item) => item.code === "runner_destination_occupied")).toBe(true);
  });
});
