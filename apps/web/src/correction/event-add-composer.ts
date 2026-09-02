import type {
  CorrectionCommand,
  StagingGameDocumentV2,
  StagingRelayEvent,
  StagingRelayEventKind,
} from "@kbo/contracts";

import {
  eventFromForm,
  newCommandId,
  newManualEventId,
  validateForm,
} from "./event-editor-registry";
import type { EditorFormModel } from "./event-editor-autofill";

export const MAX_EVENT_DRAFTS = 100;

export interface AddEventDraft {
  readonly draftId: string;
  readonly eventId: string;
  readonly editor: EditorFormModel;
}

export interface AddEventComposerState {
  readonly drafts: readonly AddEventDraft[];
  readonly activeDraftId: string;
  readonly announcement: string;
}

export type AddEventComposerAction =
  | { readonly type: "select"; readonly draftId: string }
  | { readonly type: "update"; readonly draftId: string; readonly editor: EditorFormModel }
  | { readonly type: "append"; readonly draft: AddEventDraft }
  | { readonly type: "remove"; readonly draftId: string }
  | { readonly type: "move"; readonly draftId: string; readonly direction: -1 | 1 };

export interface DraftValidation {
  readonly draft: AddEventDraft;
  readonly event: StagingRelayEvent | null;
  readonly error: string | null;
  readonly referenceEvents: readonly StagingRelayEvent[];
}

export function createAddEventDraft(
  editor: EditorFormModel,
  eventId = newManualEventId(),
  draftId = `draft-${newCommandId()}`,
): AddEventDraft {
  return { draftId, eventId, editor };
}

export function createAddEventComposerState(first: AddEventDraft): AddEventComposerState {
  return { drafts: [first], activeDraftId: first.draftId, announcement: "추가할 행 1개" };
}

export function addEventComposerReducer(
  state: AddEventComposerState,
  action: AddEventComposerAction,
): AddEventComposerState {
  if (action.type === "select") {
    return state.drafts.some((draft) => draft.draftId === action.draftId)
      ? { ...state, activeDraftId: action.draftId }
      : state;
  }
  if (action.type === "update") {
    return {
      ...state,
      drafts: state.drafts.map((draft) =>
        draft.draftId === action.draftId ? { ...draft, editor: action.editor } : draft,
      ),
    };
  }
  if (action.type === "append") {
    if (state.drafts.length >= MAX_EVENT_DRAFTS) {
      return {
        ...state,
        announcement: `최대 ${String(MAX_EVENT_DRAFTS)}개까지 추가할 수 있습니다.`,
      };
    }
    const drafts = [...state.drafts, action.draft];
    return {
      drafts,
      activeDraftId: action.draft.draftId,
      announcement: `추가할 행 ${String(drafts.length)}개`,
    };
  }
  if (action.type === "remove") {
    if (state.drafts.length === 1) return state;
    const index = state.drafts.findIndex((draft) => draft.draftId === action.draftId);
    if (index < 0) return state;
    const drafts = state.drafts.filter((draft) => draft.draftId !== action.draftId);
    const activeDraftId =
      state.activeDraftId === action.draftId
        ? (drafts[Math.min(index, drafts.length - 1)]?.draftId ?? drafts[0]?.draftId ?? "")
        : state.activeDraftId;
    return {
      drafts,
      activeDraftId,
      announcement: `행을 삭제했습니다. 추가할 행 ${String(drafts.length)}개`,
    };
  }
  const index = state.drafts.findIndex((draft) => draft.draftId === action.draftId);
  const target = index + action.direction;
  if (index < 0 || target < 0 || target >= state.drafts.length) return state;
  const drafts = [...state.drafts];
  const [moved] = drafts.splice(index, 1);
  if (moved === undefined) return state;
  drafts.splice(target, 0, moved);
  return {
    drafts,
    activeDraftId: action.draftId,
    announcement: `${String(index + 1)}번 행을 ${String(target + 1)}번으로 이동했습니다.`,
  };
}

export function validateAddEventDrafts(
  drafts: readonly AddEventDraft[],
  document: StagingGameDocumentV2,
): readonly DraftValidation[] {
  const preceding: StagingRelayEvent[] = [];
  return drafts.map((draft) => {
    const referenceEvents = [...document.events, ...preceding];
    const event =
      eventFromForm(draft.editor.form, document, undefined, draft.eventId) ??
      eventFromForm(
        { ...draft.editor.form, relayText: "작성 중인 추가 행" },
        document,
        undefined,
        draft.eventId,
      );
    const error = validateForm(draft.editor.form, document, referenceEvents);
    if (event !== null) preceding.push(event);
    return { draft, event, error, referenceEvents };
  });
}

export function buildAddEventCommand(
  drafts: readonly AddEventDraft[],
  document: StagingGameDocumentV2,
  beforeEventId: string | null,
  commandId: () => string = newCommandId,
): CorrectionCommand | null {
  if (drafts.length < 1 || drafts.length > MAX_EVENT_DRAFTS) return null;
  const validations = validateAddEventDrafts(drafts, document);
  if (validations.some((item) => item.error !== null || item.event === null)) return null;
  const commands = validations.flatMap((item) =>
    item.event === null
      ? []
      : [
          {
            commandId: commandId(),
            kind: "add_event" as const,
            event: item.event,
            beforeEventId,
          },
        ],
  );
  const only = commands[0];
  if (commands.length === 1 && only !== undefined) return only;
  return { commandId: commandId(), kind: "correction_batch", commands };
}

export function precedingDraftEvents(
  validations: readonly DraftValidation[],
  activeDraftId: string,
): readonly StagingRelayEvent[] {
  const activeIndex = validations.findIndex((item) => item.draft.draftId === activeDraftId);
  if (activeIndex <= 0) return [];
  return validations
    .slice(0, activeIndex)
    .flatMap((item) => (item.event === null ? [] : [item.event]));
}

export function transientEventsAtAnchor(
  document: StagingGameDocumentV2,
  beforeEventId: string | null,
  precedingEvents: readonly StagingRelayEvent[],
): readonly StagingRelayEvent[] {
  const index = insertionIndex(document.events, beforeEventId);
  return [...document.events.slice(0, index), ...precedingEvents, ...document.events.slice(index)];
}

export function nearestQueuedEvent(
  events: readonly StagingRelayEvent[],
  kind?: StagingRelayEventKind,
): StagingRelayEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && (kind === undefined || event.kind === kind)) return event;
  }
  return undefined;
}

function insertionIndex(
  events: readonly StagingRelayEvent[],
  beforeEventId: string | null,
): number {
  if (beforeEventId === null) return events.length;
  const index = events.findIndex((event) => event.identity.eventId === beforeEventId);
  return index < 0 ? events.length : index;
}
