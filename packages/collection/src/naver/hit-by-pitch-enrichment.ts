import type { StagingRelayEvent } from "@kbo/contracts";
import { findTerminalPitchForPlateResult } from "@kbo/game-core";

/**
 * Naver는 실제 사구 투구를 `N구 볼`로 보내면서 그 다음 결과 행에서만 사구를 명시할 수 있다.
 * 원문과 관측값은 보존하고, 같은 타석의 명시적 결과로 확인되는 직전 투구 call만 보강한다.
 */
export function enrichHitByPitchCalls(
  events: readonly StagingRelayEvent[],
): readonly StagingRelayEvent[] {
  const hitByPitchEventIds = new Set<string>();

  for (let resultIndex = 0; resultIndex < events.length; resultIndex += 1) {
    const result = events[resultIndex];
    if (result?.kind !== "plate_result" || result.payload.result !== "hit_by_pitch") {
      continue;
    }

    const pitch = findTerminalPitchForPlateResult(events, resultIndex);
    if (pitch === undefined || pitch.payload.call !== "ball") {
      continue;
    }

    hitByPitchEventIds.add(pitch.identity.eventId);
  }

  if (hitByPitchEventIds.size === 0) return events;
  return events.map((event) =>
    event.kind === "pitch" && hitByPitchEventIds.has(event.identity.eventId)
      ? { ...event, payload: { ...event.payload, call: "hit_by_pitch" } }
      : event,
  );
}
