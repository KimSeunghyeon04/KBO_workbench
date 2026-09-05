import type { RawGameBundle } from "@kbo/collection";
import type { StagingGameDocumentV2 } from "@kbo/contracts";
import { sanitizedNaverBundle } from "./naver.js";

export async function metadataBundle(
  pitches: readonly Readonly<Record<string, unknown>>[] = [
    { text: "1구 볼", speed: "133", stuff: "포크" },
  ],
): Promise<RawGameBundle> {
  const bundle = await sanitizedNaverBundle();
  return {
    ...bundle,
    payloads: {
      ...bundle.payloads,
      relay_001: {
        result: {
          textRelayData: {
            textRelays: [
              {
                inn: 1,
                homeOrAway: "0",
                textOptions: [
                  { type: 0, text: "1회초 시작" },
                  { type: 8, text: "1번 타자", currentGameState: { batter: "A1", pitcher: "HP" } },
                  ...pitches.map((pitch) => ({
                    type: 1,
                    currentGameState: { batter: "A1", pitcher: "HP" },
                    ...pitch,
                  })),
                  {
                    type: 13,
                    text: "안타",
                    result: "single",
                    currentGameState: { batter: "A1", pitcher: "HP" },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

export function stripMetadata(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  return {
    ...document,
    events: document.events.map((event) => {
      if (event.kind !== "pitch") return event;
      const payload = { ...event.payload };
      delete payload.speedKph;
      delete payload.pitchType;
      return { ...event, payload };
    }),
  };
}
