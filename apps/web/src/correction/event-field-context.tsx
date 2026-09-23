import type {
  CorrectionEventContext,
  Side,
  StagingGameDocumentV2,
  StagingRelayEvent,
} from "@kbo/contracts";
import type {
  AutofillAssignments,
  EditorAutofillContext,
  EditorFormModel,
} from "./event-editor-autofill";
import { PLATE_RESULTS, type FormState } from "./event-editor-registry";
import { eventKindLabel } from "./event-presentation";
export type EventFieldProps = {
  readonly form: FormState;
  readonly assignments: AutofillAssignments;
  readonly update: (patch: Partial<FormState>) => void;
  readonly updateModel: (transform: (current: EditorFormModel) => EditorFormModel) => void;
  readonly document: StagingGameDocumentV2;
  readonly context: EditorAutofillContext;
  readonly referenceEvents: readonly StagingRelayEvent[];
  readonly queuedEvents: readonly StagingRelayEvent[];
};
export function referenceEventLabel(
  document: StagingGameDocumentV2,
  queuedEvents: readonly StagingRelayEvent[],
  event: StagingRelayEvent,
): string {
  const queuedIndex = queuedEvents.findIndex(
    (candidate) => candidate.identity.eventId === event.identity.eventId,
  );
  if (queuedIndex >= 0)
    return `추가 ${String(queuedIndex + 1)} · ${event.relayText ?? eventKindLabel(event.kind)}`;
  const canonicalIndex = document.events.findIndex(
    (candidate) => candidate.identity.eventId === event.identity.eventId,
  );
  return `#${String(canonicalIndex + 1)} · ${event.relayText ?? eventKindLabel(event.kind)}`;
}

export function inheritedPlayerLabel(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string | null | undefined,
  role: "타자" | "투수",
): string {
  if (playerId === undefined) return `현재 타석 상태 사용 · ${role} 확인 불가`;
  if (playerId === null) return `현재 타석 상태 사용 · ${role} 미확정`;
  const player = document.rosters[side].players.find((item) => item.playerId === playerId);
  return player === undefined
    ? `현재 타석 상태 사용 · 명단 외 선수 (${playerId})`
    : `현재 타석 상태 사용 · ${document.teams[side].name} ${player.name} (${playerId})`;
}

export function contextStateForForm(
  form: FormState,
  context: EditorAutofillContext,
  state: CorrectionEventContext["before"] | undefined,
): CorrectionEventContext["before"] | undefined {
  return Number(form.inning) === context.anchorInning && form.half === context.anchorHalf
    ? state
    : undefined;
}

export function substitutionPriorities(
  form: FormState,
  state: CorrectionEventContext["before"] | undefined,
): readonly (string | null | undefined)[] {
  if (form.role === "batter") return [state?.batterId];
  if (form.role === "pitcher") return [state?.pitcherId];
  if (form.role === "runner") return state?.bases ?? [];
  return [];
}

export function autoHint(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : `자동 지정 · ${reason}`;
}

export function AutofillHint({
  reason,
}: {
  readonly reason: string | undefined;
}): React.JSX.Element | null {
  return reason === undefined ? null : (
    <small className="auto-fill-hint" aria-hidden="true">
      자동 지정 · {reason}
    </small>
  );
}

export function defaultBatterDestinationLabel(result: string): string {
  const knownResult = PLATE_RESULTS.find((candidate) => candidate === result);
  if (knownResult === undefined || knownResult === "other") return "기본 결과 사용 · 미확정";

  // compiler 기본값을 payload에 복제하지 않고 선택지 설명에만 표시한다.
  switch (knownResult) {
    case "single":
    case "walk":
    case "intentional_walk":
    case "hit_by_pitch":
    case "interference":
      return "기본 결과 사용 · 1루";
    case "double":
      return "기본 결과 사용 · 2루";
    case "triple":
      return "기본 결과 사용 · 3루";
    case "home_run":
      return "기본 결과 사용 · 홈";
    default:
      return "기본 결과 사용 · 아웃";
  }
}
