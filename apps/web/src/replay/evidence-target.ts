import type { ReplayFrame } from "@kbo/contracts";

export type ReplayEvidenceTarget = { kind: "event" | "pa" | "play"; id: string };

const targetParams = { event: "eventId", pa: "paId", play: "playId" };
export const replayEvidenceLabels = { event: "투구", pa: "타석", play: "플레이" };
export const replayOpenKey = "open";

export function replayGameUrl(gameId: string, revision: number): string {
  return `/replay?${new URLSearchParams({ gameId, revision: String(revision), [replayOpenKey]: "1" })}`;
}

export function replayEvidenceUrl(
  gameId: string,
  revision: number,
  target: ReplayEvidenceTarget,
): string {
  return `/replay?${new URLSearchParams({
    gameId,
    revision: String(revision),
    [targetParams[target.kind]]: target.id,
  })}`;
}

export function readReplayEvidenceTarget(params: URLSearchParams): ReplayEvidenceTarget | null {
  const targets: ReplayEvidenceTarget[] = [];
  for (const kind of ["event", "pa", "play"] as const) {
    const id = params.get(targetParams[kind]);
    if (id) targets.push({ kind, id });
  }
  return targets.length === 1 ? (targets[0] ?? null) : null;
}

// Called only after loadReplay has validated all pages. Never infer a frame from an ID suffix.
export function replayEvidenceIndex(
  frames: readonly ReplayFrame[],
  target: ReplayEvidenceTarget,
): number {
  if (target.kind === "play") return frames.findIndex((frame) => frame.playId === target.id);
  if (target.kind === "event")
    return frames.findIndex((frame) =>
      frame.relayEvents.some((event) => event.eventId === target.id),
    );
  const result = frames.findIndex(
    (frame) =>
      frame.kind === "plate_result" && frame.before.plateAppearance?.startEventId === target.id,
  );
  return result >= 0
    ? result
    : frames.findIndex(
        (frame) =>
          frame.relayEvents.some((event) => event.eventId === target.id) ||
          frame.before.plateAppearance?.startEventId === target.id ||
          frame.after.plateAppearance?.startEventId === target.id,
      );
}
