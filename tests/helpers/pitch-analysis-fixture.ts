import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { makeDocument } from "./game-document.js";

export function pitchAnalysisFixture(season: number, pitcherId = "hp1", vy0 = -140) {
  const base = parseStagingGameDocumentV2(
    makeDocument([
      { kind: "half_inning_start", payload: {} },
      { kind: "batter_start", payload: { batterId: "a1", pitcherId } },
      ...["직구", "슬라이더", "직구", "직구"].map((pitchType, index) => ({
        kind: "pitch",
        payload: {
          call: index === 2 ? "ball" : "swinging_strike",
          sourcePitchId: `p${index}`,
          pitchType,
          speedKph: 145,
        },
      })),
      { kind: "plate_result", payload: { result: "strikeout", batterId: "a1", pitcherId } },
    ]),
  );
  return parseStagingGameDocumentV2({
    ...base,
    metadata: {
      ...base.metadata,
      gameId: `analysis-${season}-${pitcherId}`,
      season,
      gameDate: `${season}-06-01`,
    },
    trackingCandidates: [0, 1, 2].map((index) => ({
      trackingId: `t${index}`,
      sourcePitchId: `p${index}`,
      sourcePitchOrdinal: index + 1,
      source: { endpoint: "test-tracking", blockIndex: 0, rowIndex: index },
      sequence: index,
      inning: 1,
      half: "top",
      plateAppearanceEventId: "e1",
      pitcherId,
      x0: -1,
      y0: 50,
      z0: 6,
      vx0: 2,
      vy0: index === 1 ? vy0 + 20 : vy0,
      vz0: -4,
      ax: index === 1 ? 10 : -8,
      ay: 25,
      ...(index === 2 ? {} : { az: -15 }),
      crossPlateX: 0.1,
      crossPlateY: 1.4167,
      bottomSz: 1.5,
      topSz: 3.2,
      resolution: { kind: "linked", pitchEventId: `e${index + 2}` },
    })),
  });
}
