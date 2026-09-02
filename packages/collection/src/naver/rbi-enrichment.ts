import type { PlateResult, StagingRelayEvent } from "@kbo/contracts";

import { isNonRbiRunnerText } from "./lexicon.js";

const creditableResults: ReadonlySet<PlateResult> = new Set([
  "single",
  "double",
  "triple",
  "home_run",
  "field_out",
  "sacrifice_bunt",
  "sacrifice_fly",
  "walk",
  "intentional_walk",
  "hit_by_pitch",
  "fielder_choice",
]);

/** Collection 전용 semantic 보강이다. compiler는 provider 문구를 해석하지 않는다. */
export function enrichCreditedRbi(
  events: readonly StagingRelayEvent[],
): readonly StagingRelayEvent[] {
  const scoredByResult = new Map<
    string,
    Extract<StagingRelayEvent, { kind: "runner_advance" }>[]
  >();
  for (const event of events) {
    if (
      event.kind !== "runner_advance" ||
      event.payload.context.kind !== "plate_result" ||
      event.payload.outcome !== "scored"
    ) {
      continue;
    }
    const linked = scoredByResult.get(event.payload.context.plateResultEventId) ?? [];
    linked.push(event);
    scoredByResult.set(event.payload.context.plateResultEventId, linked);
  }
  return events.map((event) => {
    if (event.kind !== "plate_result" || event.payload.creditedRbi !== undefined) return event;
    const linked = scoredByResult.get(event.identity.eventId) ?? [];
    const batterRun = event.payload.result === "home_run" ? 1 : 0;
    const runsScored = linked.length + batterRun;
    if (runsScored === 0) return event;
    if (!creditableResults.has(event.payload.result)) return event;
    const creditedRbi = Math.min(
      runsScored,
      linked.filter((runner) => !isNonRbiRunnerText(runner.relayText ?? null)).length + batterRun,
    );
    return { ...event, payload: { ...event.payload, creditedRbi } };
  });
}
