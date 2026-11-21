import type { StagingGameDocumentV2 } from "@kbo/contracts";
import { excludeTrackingForPitch } from "./tracking-commands.js";

function selectedIds(
  document: StagingGameDocumentV2,
  eventIds: readonly string[],
): ReadonlySet<string> {
  const selected = new Set(eventIds);
  const existing = new Set(document.events.map((event) => event.identity.eventId));
  for (const id of selected) {
    if (!existing.has(id)) throw new Error(`원장 event를 찾을 수 없습니다: ${id}`);
  }
  return selected;
}

export function deleteEvents(
  document: StagingGameDocumentV2,
  eventIds: readonly string[],
): StagingGameDocumentV2 {
  const selected = selectedIds(document, eventIds);
  let corrected = document;
  for (const event of document.events) {
    if (event.kind === "pitch" && selected.has(event.identity.eventId))
      corrected = excludeTrackingForPitch(
        corrected,
        event.identity.eventId,
        "연결된 원장 투구 행이 삭제되었습니다.",
      );
  }
  return {
    ...corrected,
    events: corrected.events.filter((event) => !selected.has(event.identity.eventId)),
  };
}

export function moveEvents(
  document: StagingGameDocumentV2,
  eventIds: readonly string[],
  beforeEventId: string | null,
): StagingGameDocumentV2 {
  const selected = selectedIds(document, eventIds);
  if (beforeEventId !== null && selected.has(beforeEventId))
    throw new Error("이동 기준 행은 선택한 행에 포함될 수 없습니다.");
  const remaining = document.events.filter((event) => !selected.has(event.identity.eventId));
  const index =
    beforeEventId === null
      ? remaining.length
      : remaining.findIndex((event) => event.identity.eventId === beforeEventId);
  if (index < 0) throw new Error(`이동 기준 event를 찾을 수 없습니다: ${String(beforeEventId)}`);
  // 클릭 순서가 아니라 원장 순서를 보존하고, 전체 이동 뒤 한 번만 재컴파일한다.
  const moving = document.events.filter((event) => selected.has(event.identity.eventId));
  return {
    ...document,
    events: [...remaining.slice(0, index), ...moving, ...remaining.slice(index)],
  };
}
