import { extractNaverSourceEvidence } from "@kbo/collection";
import { describe, expect, it } from "vitest";

describe("Naver immutable source evidence", () => {
  it("비식별 relay와 tracking 원문을 source identity 기준으로 결정적으로 추출한다", () => {
    const evidence = extractNaverSourceEvidence({
      event: {
        identity: {
          kind: "source",
          eventId: "event-2",
          sourceEventId: "relay:0:2",
          endpoint: "relay",
          blockIndex: 0,
          eventIndex: 2,
        },
        sequence: 2,
        kind: "pitch",
        inning: 1,
        half: "top",
        relayText: "1구 볼",
        payload: {
          call: "ball",
          batterId: "batter-anon",
          pitcherId: "pitcher-anon",
          sourcePitchId: "pitch-anon-1",
        },
      },
      payloads: {
        relay: {
          result: {
            textRelayData: {
              textRelays: [
                {
                  textOptions: [
                    { seqno: 0, text: "1회초 시작" },
                    { seqno: 1, text: "비식별 타자 타석" },
                    { seqno: 2, text: "1구 볼" },
                  ],
                  ptsOptions: [
                    { pitchId: "different" },
                    { pitchId: "pitch-anon-1", crossPlateX: 0.12 },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    expect(evidence).toMatchObject({
      eventId: "event-2",
      endpoint: "relay",
      relayRows: [
        { rowIndex: 0, selected: false },
        { rowIndex: 1, selected: false },
        { rowIndex: 2, selected: true },
      ],
      trackingRows: [{ rowIndex: 1, sourcePitchId: "pitch-anon-1" }],
    });
  });
});
