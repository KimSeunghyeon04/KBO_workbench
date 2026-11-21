import { parseStagingGameDocumentV2 } from "@kbo/contracts";

import { makeDocument } from "./game-document.js";

export function mixedPitchDocument() {
  const document = parseStagingGameDocumentV2(
    makeDocument([
      { kind: "half_inning_start", payload: {} },
      { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "automatic_ball" } },
      { kind: "pitch", payload: { call: "ball", sourcePitchId: "tracked-ball" } },
      { kind: "pitch", payload: { call: "automatic_strike" } },
      { kind: "pitch", payload: { call: "no_pitch" } },
      { kind: "pitch", payload: { call: "called_strike" } },
      { kind: "pitch", payload: { call: "in_play" } },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId: "a1", pitcherId: "hp1", outsRecorded: 1 },
      },
      { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "in_play" } },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId: "a2", pitcherId: "hp1", outsRecorded: 1 },
      },
    ]),
  );
  return parseStagingGameDocumentV2({
    ...document,
    trackingCandidates: [
      {
        trackingId: "t1",
        sequence: 0,
        source: { endpoint: "tracking", blockIndex: 0, rowIndex: 0 },
        sourcePitchId: "tracked-ball",
        sourcePitchOrdinal: 1,
        inning: 1,
        half: "top",
        plateAppearanceEventId: "e1",
        batterId: "a1",
        pitcherId: "hp1",
        resolution: { kind: "linked", pitchEventId: "e3" },
      },
    ],
  });
}
