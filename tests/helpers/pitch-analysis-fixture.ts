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

export function releasePitchAnalysisFixture(season: number, game: number, pitcherId = "hp1") {
  const pitches = Array.from({ length: 96 }, (_, index) => {
    const pitchType = index % 2 === 0 ? "직구" : "슬라이더";
    return {
      kind: "pitch",
      payload: {
        call: index < 2 ? "called_strike" : index === 95 ? "swinging_strike" : "foul",
        sourcePitchId: `p${index}`,
        pitchType,
        speedKph: 130,
      },
    };
  });
  const base = parseStagingGameDocumentV2(
    makeDocument(
      [
        { kind: "half_inning_start", payload: {} },
        { kind: "batter_start", payload: { batterId: "a1", pitcherId } },
        ...pitches,
        { kind: "plate_result", payload: { result: "strikeout", batterId: "a1", pitcherId } },
      ],
      "final",
    ),
  );
  const gameId = `release-${season}-${game}-${pitcherId}`;
  return parseStagingGameDocumentV2({
    ...base,
    source: { ...base.source, sourceGameId: gameId },
    metadata: { ...base.metadata, gameId, season, gameDate: `${season}-06-0${game + 1}` },
    trackingCandidates: pitches.map(({ payload }, index) => {
      const pitch = index >> 1;
      const sign = (bit: number) => ((pitch & bit) === 0 ? -1 : 1);
      const fastball = payload.pitchType === "직구";
      const y0 = game === 0 ? 50 : 55;
      const time = ((fastball ? 55 : 54) - y0) / 100;
      const vxRelease = sign(4) * 2;
      const vzRelease = sign(8) * 2;
      const ax = fastball ? -8 : 8;
      const az = -15;
      return {
        trackingId: `t${index}`,
        sourcePitchId: payload.sourcePitchId,
        sourcePitchOrdinal: index + 1,
        source: { endpoint: "test-tracking", blockIndex: 0, rowIndex: index },
        sequence: index,
        inning: 1,
        half: "top",
        plateAppearanceEventId: "e1",
        pitcherId,
        x0: 1 + sign(1) / 10 + vxRelease * time + (ax * time ** 2) / 2,
        y0,
        z0: 6 + sign(2) / 10 + vzRelease * time + (az * time ** 2) / 2,
        vx0: vxRelease + ax * time,
        vy0: -100,
        vz0: vzRelease + az * time,
        ax,
        ay: 0,
        az,
        crossPlateX: 0.1,
        crossPlateY: 17 / 12,
        resolution: { kind: "linked", pitchEventId: `e${index + 2}` },
      };
    }),
  });
}
