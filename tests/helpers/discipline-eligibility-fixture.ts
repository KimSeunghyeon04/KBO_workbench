import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { makeDocument, safe } from "./game-document.js";

export function disciplineEligibilityFixture() {
  const document = parseStagingGameDocumentV2(
    makeDocument([
      { kind: "half_inning_start", payload: {} },
      { kind: "batter_start", payload: { batterId: "a1", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "foul_bunt" } },
      { kind: "pitch", payload: { call: "in_play" } },
      {
        kind: "plate_result",
        payload: { result: "field_out", batterId: "a1", pitcherId: "hp1", outsRecorded: 1 },
      },
      { kind: "batter_start", payload: { batterId: "a2", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "ball" } },
      { kind: "pitch", payload: { call: "in_play" } },
      {
        kind: "plate_result",
        payload: {
          result: "field_out",
          batterId: "a2",
          pitcherId: "hp1",
          outsRecorded: 1,
          isBunt: true,
        },
      },
      { kind: "batter_start", payload: { batterId: "a3", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "hit_by_pitch" } },
      {
        kind: "plate_result",
        payload: { result: "hit_by_pitch", batterId: "a3", pitcherId: "hp1" },
      },
      { kind: "batter_start", payload: { batterId: "a4", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "ball" } },
      {
        kind: "plate_appearance_result",
        payload: {
          result: "intentional_walk",
          batterId: "a4",
          pitcherId: "hp1",
          movements: [safe("a3", 1, 2, 0)],
        },
      },
      { kind: "batter_start", payload: { batterId: "a5", pitcherId: "hp1" } },
      { kind: "pitch", payload: { call: "automatic_ball" } },
      { kind: "pitch", payload: { call: "called_strike" } },
    ]),
  );
  return parseStagingGameDocumentV2({
    ...document,
    metadata: {
      ...document.metadata,
      gameId: "discipline-eligibility",
      season: 2024,
      gameDate: "2024-06-02",
    },
  });
}
