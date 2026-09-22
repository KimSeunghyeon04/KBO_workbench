import { canonicalStringify } from "@kbo/contracts";

import type { EditorAutofillContext } from "./event-editor-autofill";
import { eventFromForm, type FormState } from "./event-editor-registry";

export function runnerResponsibilityLabel(form: FormState, context: EditorAutofillContext): string {
  const original = context.selectedEvent;
  const compiled = context.selectedEventContext;
  if (original?.kind !== "runner_advance" || !compiled?.applied) return "미확정 · 반영 후 확인";
  const candidate = eventFromForm(form, context.document, original);
  // 이미 계산된 이동과 같은 입력일 때만 이름을 보여준다. 수정 중인 이동이나
  // 명시적 지정을 해제한 경우의 책임을 브라우저에서 추측하지 않는다.
  if (
    candidate === null ||
    canonicalStringify(candidate) !==
      canonicalStringify({ ...original, relayText: candidate.relayText }) ||
    compiled.runnerMovement?.runnerId !== form.runnerId
  )
    return "미확정 · 반영 후 확인";
  const pitcherId = compiled.runnerMovement.responsiblePitcherId;
  const side = form.half === "top" ? "home" : "away";
  const player = context.document.rosters[side].players.find(
    (player) => player.playerId === pitcherId,
  );
  return player === undefined
    ? `명단 외 선수 (${pitcherId})`
    : `${context.document.teams[side].name} · ${player.name} (${pitcherId})`;
}
