import type { StagingRelayEvent } from "@kbo/contracts";

type PitchEvent = Extract<StagingRelayEvent, { readonly kind: "pitch" }>;

export function sourcePitchIdFields(value: string): Readonly<{ sourcePitchId?: string }> {
  const sourcePitchId = value.trim();
  return sourcePitchId === "" ? {} : { sourcePitchId };
}

export function withPitchSourceId(event: PitchEvent, value: string): PitchEvent {
  const payload = { ...event.payload };
  delete payload.sourcePitchId;
  return {
    ...event,
    payload: { ...payload, ...sourcePitchIdFields(value) },
  };
}

export function sameKnownSourcePitchId(left: PitchEvent, right: PitchEvent): boolean {
  const sourcePitchId = left.payload.sourcePitchId;
  return sourcePitchId !== undefined && sourcePitchId === right.payload.sourcePitchId;
}

export function sourcePitchIdLabel(value: string | undefined): string {
  return value ?? "원천 ID 없음";
}
