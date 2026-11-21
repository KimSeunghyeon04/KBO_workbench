import { describe, expect, it } from "vitest";

import { mapNaverGame } from "@kbo/collection";
import { sanitizedNaverBundle } from "../helpers/naver.js";

const reach = "원정 타자 : 1루수 앞 땅볼로 출루";

async function mapReach(
  cell: string,
  options: { priorWalk?: boolean; resultCode?: string; scoringRunner?: boolean } = {},
) {
  const base = await sanitizedNaverBundle();
  const currentGameState = { batter: "A1", pitcher: "HP" };
  return mapNaverGame({
    ...base,
    payloads: {
      ...base.payloads,
      record: {
        battersBoxscore: {
          away: [
            { playerCode: "A1", ab: 1, bb: options.priorWalk ? 1 : 0, hit: 0, inn1: cell },
            ...(options.scoringRunner
              ? [{ playerCode: "A2", name: "원정 주자", ab: 0, bb: 1, hit: 0, inn1: "4구" }]
              : []),
          ],
          home: [],
        },
      },
      relay_001: {
        textRelays: [
          {
            inn: 1,
            homeOrAway: "0",
            textOptions: [
              { type: 0, seqno: 1, text: "1회초 시작" },
              ...(options.scoringRunner
                ? [
                    {
                      type: 8,
                      seqno: 2,
                      text: "2번타자 원정 주자",
                      batterId: "A2",
                      pitcherId: "HP",
                    },
                    {
                      type: 23,
                      seqno: 3,
                      text: "원정 주자 : 볼넷",
                      batterId: "A2",
                      pitcherId: "HP",
                    },
                  ]
                : []),
              {
                type: 8,
                seqno: options.scoringRunner ? 4 : 2,
                text: "1번타자 원정 타자",
                currentGameState,
              },
              ...(options.priorWalk
                ? [
                    { type: 23, seqno: 3, text: "원정 타자 : 볼넷", currentGameState },
                    { type: 8, seqno: 4, text: "1번타자 원정 타자", currentGameState },
                  ]
                : []),
              {
                type: 23,
                seqno: 5,
                text: reach,
                currentGameState,
                ...(options.resultCode === undefined ? {} : { result: options.resultCode }),
              },
              ...(options.scoringRunner
                ? [{ type: 24, seqno: 6, text: "1루주자 원정 주자 : 실책으로 홈인" }]
                : []),
            ],
          },
        ],
      },
    },
  });
}

describe("Naver 박스스코어 타석 근거", () => {
  it.each(["1실", "2실", "유실", "/1실"])("일반 땅볼 출루를 %s로 대조한다", async (cell) => {
    const mapped = await mapReach(cell);
    expect(mapped.document.events.at(-1)).toMatchObject({
      kind: "plate_result",
      relayText: reach,
      identity: { sourceEventId: "5" },
      payload: { result: "reached_on_error" },
    });
  });

  it.each(["1땅", "", "4구/1실"])(
    "연결할 실책 근거가 없는 %j는 기존 판정을 유지한다",
    async (cell) => {
      const mapped = await mapReach(cell);
      expect(mapped.document.events.at(-1)).toMatchObject({
        payload: { result: "fielder_choice" },
      });
    },
  );

  it("같은 이닝 두 타석을 다른 타석의 결과까지 대조하여 순서대로 연결한다", async () => {
    const mapped = await mapReach("4구/1실", { priorWalk: true });
    expect(
      mapped.document.events.filter((e) => e.kind === "plate_result").map((e) => e.payload.result),
    ).toEqual(["walk", "reached_on_error"]);
    const conflicting = await mapReach("투안/1실", { priorWalk: true });
    expect(conflicting.document.events.at(-1)).toMatchObject({
      payload: { result: "fielder_choice" },
    });
  });

  it("구조화된 야수선택을 일반 출루 문구로 취급하지 않는다", async () => {
    const mapped = await mapReach("1실", { resultCode: "fielder_choice" });
    expect(mapped.document.events.at(-1)).toMatchObject({ payload: { result: "fielder_choice" } });
  });

  it("주자 실책 중계는 그대로 보존하고 기록지 약호로 두 타석을 구분한다", async () => {
    const choice = await mapReach("1땅", { scoringRunner: true });
    const error = await mapReach("1실", { scoringRunner: true });
    const runner = error.document.events.at(-1);
    expect(runner).toMatchObject({
      kind: "runner_advance",
      relayText: "1루주자 원정 주자 : 실책으로 홈인",
      payload: { runnerId: "A2", outcome: "scored", context: { kind: "plate_result" } },
    });
    expect(runner).toEqual(choice.document.events.at(-1));
    expect(choice.document.events.at(-2)).toMatchObject({
      payload: { result: "fielder_choice", creditedRbi: 0 },
    });
    expect(error.document.events.at(-2)).toMatchObject({
      payload: { result: "reached_on_error", creditedRbi: 0 },
    });
  });
});
