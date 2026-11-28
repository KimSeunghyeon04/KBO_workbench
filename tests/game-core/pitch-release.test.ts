import { expect, it } from "vitest";
import { estimatePitchReleases } from "@kbo/game-core";

function sample(origin: number, releasePlane: number) {
  return Array.from({ length: 144 }, (_, i) => {
    const game = Math.floor(i / 48);
    const sign = (bit: number) => ((i & bit) === 0 ? -1 : 1);
    const relX = 1 + game / 2 + sign(1) * 0.1;
    const relZ = 6 + game / 5 + sign(2) * 0.1;
    const slopeX = game / 7 + sign(4) * 0.02;
    const slopeZ = game / 9 + sign(8) * 0.02;
    return {
      gameId: `g${game}`,
      pitchType: "직구",
      trackingId: String(i),
      supported: true,
      x0: relX + (origin - releasePlane) * slopeX,
      y0: origin,
      z0: relZ + (origin - releasePlane) * slopeZ,
      vx0: -100 * slopeX,
      vy0: -100,
      vz0: -100 * slopeZ,
      ax: 20 * slopeX,
      ay: 20,
      az: 20 * slopeZ,
    };
  });
}

it("fits a common release plane from 50 and 55 ft despite between-game motion", () => {
  for (const origin of [50, 55]) {
    const [group] = estimatePitchReleases(sample(origin, 54));
    expect(group).toMatchObject({ pitchType: "직구", pitches: 144, games: 3 });
    expect(group?.estimate?.xCm).toBeCloseTo(45.72, 10);
    expect(group?.estimate?.heightCm).toBeCloseTo(188.976, 10);
  }
});

it("keeps each pitch type's sample and leaves small or unphysical fits unavailable", () => {
  const fastballs = sample(50, 54);
  expect(
    estimatePitchReleases([
      ...fastballs,
      ...fastballs.slice(0, 119).map((r) => ({ ...r, pitchType: "커브" })),
      ...fastballs.map((r) => ({ ...r, pitchType: "슬라이더", gameId: "one" })),
      ...sample(55, 62).map((r) => ({ ...r, pitchType: "포크" })),
      ...fastballs.map((r) => ({ ...r, pitchType: "미지원", supported: false })),
    ]),
  ).toEqual([
    { pitchType: "슬라이더", pitches: 144, games: 1, estimate: null },
    { pitchType: "직구", pitches: 144, games: 3, estimate: expect.any(Object) },
    { pitchType: "포크", pitches: 144, games: 3, estimate: null },
    { pitchType: "커브", pitches: 119, games: 3, estimate: null },
  ]);
});
