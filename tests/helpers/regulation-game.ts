import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { makeDocument } from "./game-document.js";
export function regulationGame(season: number) {
  const events: Parameters<typeof makeDocument>[0][number][] = [];
  for (let inning = 1; inning <= 9; inning++)
    for (const half of ["top", "bottom"] as const) {
      const batterId = half === "top" ? "a1" : "h1",
        pitcherId = half === "top" ? "hp1" : "a1";
      events.push({ kind: "half_inning_start", inning, half, payload: {} });
      if (inning === 1 && half === "top")
        events.push(
          { kind: "batter_start", inning, half, payload: { batterId, pitcherId } },
          { kind: "pitch", inning, half, payload: { batterId, pitcherId, call: "in_play" } },
          {
            kind: "plate_result",
            inning,
            half,
            payload: { result: "home_run", batterId, pitcherId },
          },
        );
      for (let i = 0; i < 3; i++)
        events.push(
          { kind: "batter_start", inning, half, payload: { batterId, pitcherId } },
          { kind: "pitch", inning, half, payload: { batterId, pitcherId, call: "in_play" } },
          {
            kind: "plate_result",
            inning,
            half,
            payload: { result: "field_out", batterId, pitcherId },
          },
        );
    }
  const base = parseStagingGameDocumentV2(makeDocument(events, "final"));
  return parseStagingGameDocumentV2({
    ...base,
    source: { ...base.source, sourceGameId: `regulation-${season}` },
    metadata: {
      ...base.metadata,
      season,
      gameDate: `${season}-06-01`,
      gameId: `regulation-${season}`,
    },
  });
}
