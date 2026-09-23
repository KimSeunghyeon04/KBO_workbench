import type {
  CorrectionCommand,
  CorrectionSession,
  Half,
  StagingGameDocumentV2,
  StagingRelayEvent,
  StagingRelayEventKind,
} from "@kbo/contracts";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pitchOrdinalAt, suggestedRelayText } from "../events/relay-text";
import { AddEventQueue, DrawerHeader } from "./correction-drawer-parts";
import {
  addEventComposerReducer,
  buildAddEventCommand,
  createAddEventComposerState,
  createAddEventDraft,
  MAX_EVENT_DRAFTS,
  nearestQueuedEvent,
  precedingDraftEvents,
  transientEventsAtAnchor,
  validateAddEventDrafts,
} from "./event-add-composer";
import {
  buildEditorAutofillContext,
  initialEditorModel,
  invalidateContextAssignments,
  manualFormPatch,
  modelForKind,
  queuedPlateResultModel,
  queuedReviewTargetModel,
  type EditorFormModel,
} from "./event-editor-autofill";
import {
  EVENT_KINDS,
  eventFromForm,
  newCommandId,
  validateForm,
  type DrawerRequest,
  type FormState,
} from "./event-editor-registry";
import { EventFields } from "./event-fields";
import { eventKindLabel } from "./event-presentation";
import {
  decodeObservedStateForm,
  observedStateChanged,
  ObservedStateEditor,
  observedStateForm,
} from "./observed-state-editor";
export function CorrectionDrawer({
  request,
  session,
  selectedEvent,
  pending,
  error,
  onClose,
  onApply,
}: {
  readonly request: DrawerRequest;
  readonly session: CorrectionSession;
  readonly selectedEvent: StagingRelayEvent | undefined;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onApply: (command: CorrectionCommand) => void;
}): React.JSX.Element {
  const originalEvent = request.mode === "replace_event" ? selectedEvent : undefined;
  const [observationForm, setObservationForm] = useState(() =>
    observedStateForm(originalEvent?.observedStateAfter),
  );
  const observation = decodeObservedStateForm(observationForm, originalEvent?.observedStateAfter);
  const autofillContext = buildEditorAutofillContext(session, request);
  const [singleEditor, setSingleEditor] = useState<EditorFormModel>(() =>
    initialEditorModel(request, originalEvent, autofillContext),
  );
  const [composer, dispatchComposer] = useReducer(
    addEventComposerReducer,
    initialEditorModel(request, originalEvent, autofillContext),
    (editor) => createAddEventComposerState(createAddEventDraft(editor)),
  );
  const [dirty, setDirty] = useState(false);
  const [eventEdited, setEventEdited] = useState(false);
  const observationChanged =
    originalEvent?.identity.kind === "source" &&
    observation.value !== null &&
    observedStateChanged(observation.value, originalEvent.observedStateAfter);
  const observationOnly = observationChanged && !eventEdited;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const gameDocument = session.draftDocument;
  const addMode = request.mode === "add_event";
  const activeDraft = composer.drafts.find((draft) => draft.draftId === composer.activeDraftId);
  const editor = addMode ? (activeDraft?.editor ?? singleEditor) : singleEditor;
  const form = editor.form;
  const draftValidations = addMode ? validateAddEventDrafts(composer.drafts, gameDocument) : [];
  const activeValidation = draftValidations.find(
    (item) => item.draft.draftId === composer.activeDraftId,
  );
  const queuedBeforeActive = addMode
    ? precedingDraftEvents(draftValidations, composer.activeDraftId)
    : [];
  const referenceEvents = [...queuedBeforeActive, ...gameDocument.events];
  const updateEditor = (next: EditorFormModel): void => {
    if (addMode && activeDraft !== undefined) {
      dispatchComposer({ type: "update", draftId: activeDraft.draftId, editor: next });
    } else setSingleEditor(next);
  };
  const update = (patch: Partial<FormState>): void => {
    setEventEdited(true);
    updateEditor(manualFormPatch(editor, patch));
    setDirty(true);
    setConfirmDiscard(false);
    setComposerError(null);
  };
  const updateModel = (transform: (current: EditorFormModel) => EditorFormModel): void => {
    setEventEdited(true);
    updateEditor(transform(editor));
    setDirty(true);
    setConfirmDiscard(false);
    setComposerError(null);
  };
  const candidate = addMode
    ? (activeValidation?.event ?? null)
    : eventFromForm(form, gameDocument, originalEvent);
  const suggestionCandidate =
    candidate ??
    eventFromForm(
      form.relayText.trim() === "" ? { ...form, relayText: "문구 제안" } : form,
      gameDocument,
      originalEvent,
      activeDraft?.eventId,
    );
  const validation =
    request.mode === "move_event"
      ? null
      : addMode
        ? activeValidation === undefined
          ? "추가할 행을 찾을 수 없습니다."
          : activeValidation.error
        : (observation.error ?? (observationOnly ? null : validateForm(form, gameDocument)));
  const suggestionEvents = addMode
    ? transientEventsAtAnchor(gameDocument, request.beforeEventId, queuedBeforeActive)
    : gameDocument.events;
  const suggestionIndex = addMode
    ? canonicalIndexForRequest(gameDocument, request) + queuedBeforeActive.length
    : canonicalIndexForRequest(gameDocument, request);
  const title =
    request.mode === "add_event"
      ? "원장 행 추가"
      : request.mode === "replace_event"
        ? "원장 행 수정"
        : "위치 지정 이동";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    queueMicrotask(() =>
      formRef.current
        ?.querySelector<HTMLElement>(
          "select:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
        )
        ?.focus(),
    );
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      opener?.focus();
    };
  }, []);

  const requestClose = (): void => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };
  const submit = (): void => {
    if (request.mode === "move_event") {
      onApply({
        commandId: newCommandId(),
        kind: "move_event",
        eventId: request.eventId,
        beforeEventId: form.beforeEventId === "" ? null : form.beforeEventId,
      });
      return;
    }
    if (addMode) {
      const firstInvalid = draftValidations.find(
        (item) => item.error !== null || item.event === null,
      );
      if (firstInvalid !== undefined) {
        dispatchComposer({ type: "select", draftId: firstInvalid.draft.draftId });
        const index = composer.drafts.findIndex(
          (draft) => draft.draftId === firstInvalid.draft.draftId,
        );
        setComposerError(
          `${String(index + 1)}번 행: ${firstInvalid.error ?? "입력값을 확인하세요."}`,
        );
        queueMicrotask(() => focusInvalidEditorField(formRef.current, firstInvalid.error));
        return;
      }
      const command = buildAddEventCommand(composer.drafts, gameDocument, request.beforeEventId);
      if (command !== null) onApply(command);
      return;
    }
    if (validation !== null) return;
    const observationCommand =
      observationChanged && observation.value !== null
        ? {
            commandId: newCommandId(),
            kind: "update_observed_state" as const,
            eventId: request.eventId,
            observedStateAfter: observation.value,
          }
        : null;
    if (observationOnly && observationCommand !== null) {
      onApply(observationCommand);
      return;
    }
    if (candidate === null) return;
    const replace: CorrectionCommand = {
      commandId: newCommandId(),
      kind: "replace_event",
      eventId: request.eventId,
      event: candidate,
    };
    if (observationCommand !== null) {
      onApply({
        commandId: newCommandId(),
        kind: "correction_batch",
        commands: [replace, observationCommand],
      });
    } else onApply(replace);
  };

  const changeKind = (kind: StagingRelayEventKind): void => {
    let next = modelForKind(editor.form, kind, autofillContext);
    if (addMode) {
      if (kind === "runner_advance") {
        const queuedResult = nearestQueuedEvent(queuedBeforeActive, "plate_result");
        if (queuedResult !== undefined)
          next = queuedPlateResultModel(next, queuedResult.identity.eventId);
      }
      if (kind === "review") {
        const queuedTarget = nearestQueuedEvent(queuedBeforeActive);
        if (queuedTarget !== undefined)
          next = queuedReviewTargetModel(next, queuedTarget.identity.eventId);
      }
    }
    updateModel(() => next);
  };

  const addNextDraft = (): void => {
    const previousDraft = composer.drafts.at(-1);
    if (previousDraft === undefined) return;
    const queuedPlateResultId =
      previousDraft.editor.form.kind === "plate_result"
        ? previousDraft.eventId
        : previousDraft.editor.form.kind === "runner_advance" &&
            previousDraft.editor.form.contextKind === "plate_result" &&
            previousDraft.editor.form.plateResultEventId !== ""
          ? previousDraft.editor.form.plateResultEventId
          : undefined;
    const nextKind = queuedPlateResultId === undefined ? "pitch" : "runner_advance";
    let next = modelForKind(
      { ...previousDraft.editor.form, relayText: "" },
      nextKind,
      autofillContext,
    );
    if (queuedPlateResultId !== undefined) next = queuedPlateResultModel(next, queuedPlateResultId);
    dispatchComposer({ type: "append", draft: createAddEventDraft(next) });
    setDirty(true);
    setConfirmDiscard(false);
    setComposerError(null);
    queueMicrotask(() => focusInvalidEditorField(formRef.current, null));
  };
  return createPortal(
    <dialog
      ref={dialogRef}
      className="correction-drawer-layer"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <button
        type="button"
        className="correction-drawer-backdrop"
        tabIndex={-1}
        aria-label="편집 닫기"
        onClick={requestClose}
      />
      <section className="correction-drawer">
        <DrawerHeader
          title={title}
          titleId={titleId}
          descriptionId={descriptionId}
          pending={pending}
          onClose={requestClose}
        />
        <form
          ref={formRef}
          className="correction-drawer-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="correction-drawer-body">
            <fieldset className="command-editor" disabled={pending}>
              {addMode ? (
                <AddEventQueue
                  drafts={composer.drafts}
                  validations={draftValidations}
                  activeDraftId={composer.activeDraftId}
                  announcement={composer.announcement}
                  pending={pending}
                  onSelect={(draftId) => {
                    dispatchComposer({ type: "select", draftId });
                    setComposerError(null);
                  }}
                  onMove={(draftId, direction) => {
                    dispatchComposer({ type: "move", draftId, direction });
                    setDirty(true);
                    setConfirmDiscard(false);
                    setComposerError(null);
                  }}
                  onRemove={(draftId) => {
                    dispatchComposer({ type: "remove", draftId });
                    setDirty(true);
                    setConfirmDiscard(false);
                    setComposerError(null);
                  }}
                />
              ) : null}
              {request.mode === "move_event" ? (
                <label>
                  앞에 배치
                  <select
                    value={form.beforeEventId}
                    onChange={(event) => update({ beforeEventId: event.target.value })}
                  >
                    <option value="">원장 맨 뒤</option>
                    {gameDocument.events
                      .filter((item) => item.identity.eventId !== request.eventId)
                      .map((item) => (
                        <option value={item.identity.eventId} key={item.identity.eventId}>
                          #{String(item.sequence + 1)} ·{" "}
                          {item.relayText ?? eventKindLabel(item.kind)}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    행 종류
                    <select
                      value={form.kind}
                      onChange={(event) => {
                        const kind = event.target.value as StagingRelayEventKind;
                        changeKind(kind);
                      }}
                    >
                      {EVENT_KINDS.map((kind) => (
                        <option value={kind} key={kind}>
                          {eventKindLabel(kind)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="form-grid two">
                    <label>
                      회
                      <input
                        type="number"
                        data-editor-field="inning"
                        min="1"
                        max="99"
                        value={form.inning}
                        onChange={(event) => {
                          const inning = event.target.value;
                          updateModel((current) =>
                            invalidateContextAssignments(current, { inning }, autofillContext),
                          );
                        }}
                      />
                    </label>
                    <label>
                      초/말
                      <select
                        value={form.half}
                        onChange={(event) => {
                          const half = event.target.value as Half;
                          updateModel((current) =>
                            invalidateContextAssignments(current, { half }, autofillContext),
                          );
                        }}
                      >
                        <option value="top">초</option>
                        <option value="bottom">말</option>
                      </select>
                    </label>
                  </div>
                  <div className="auto-fill-notice" role="status" aria-live="polite">
                    {editor.notice}
                  </div>
                  <EventFields
                    form={form}
                    assignments={editor.assignments}
                    update={update}
                    updateModel={updateModel}
                    document={gameDocument}
                    context={autofillContext}
                    referenceEvents={referenceEvents}
                    queuedEvents={queuedBeforeActive}
                  />
                  {originalEvent?.identity.kind === "source" ? (
                    <ObservedStateEditor
                      form={observationForm}
                      document={gameDocument}
                      side={originalEvent.half === "top" ? "away" : "home"}
                      onChange={(next) => {
                        setObservationForm(next);
                        setDirty(true);
                        setConfirmDiscard(false);
                      }}
                    />
                  ) : null}
                  <div className="relay-text-field">
                    <label htmlFor={`${titleId}-relay-text`}>중계 문구</label>
                    <textarea
                      id={`${titleId}-relay-text`}
                      data-editor-field="relay-text"
                      value={form.relayText}
                      minLength={1}
                      maxLength={1000}
                      onChange={(event) => update({ relayText: event.target.value })}
                    />
                    <button
                      type="button"
                      className="secondary-button relay-text-auto-button"
                      onClick={() => {
                        const value =
                          suggestionCandidate === null
                            ? ""
                            : relayTextSuggestion(
                                gameDocument,
                                suggestionCandidate,
                                suggestionIndex,
                                suggestionEvents,
                              );
                        update({ relayText: value });
                      }}
                    >
                      문구 제안
                    </button>
                    <small>{String(form.relayText.length)} / 1000</small>
                    {originalEvent?.identity.kind === "source" ? (
                      <small>
                        수정한 문구는 보정 원장에 저장됩니다. 최초 원문은 근거 패널에서 확인할 수
                        있습니다.
                      </small>
                    ) : null}
                  </div>
                </>
              )}
            </fieldset>
          </div>
          <footer className="correction-drawer-footer">
            {composerError !== null ? <p className="inline-error">{composerError}</p> : null}
            {composerError === null && validation !== null ? (
              <p className="inline-error">{validation}</p>
            ) : null}
            {error !== null ? <p className="inline-error">{error.message}</p> : null}
            {confirmDiscard ? (
              <div className="drawer-discard-confirmation" role="alert">
                <strong>입력 중인 변경을 버릴까요?</strong>
                <div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfirmDiscard(false)}
                  >
                    편집 계속
                  </button>
                  <button type="button" className="text-button" onClick={onClose}>
                    변경 버리기
                  </button>
                </div>
              </div>
            ) : (
              <div className="drawer-footer-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={requestClose}
                >
                  취소
                </button>
                {addMode ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending || composer.drafts.length >= MAX_EVENT_DRAFTS}
                    onClick={addNextDraft}
                  >
                    다음 행 추가
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary-button drawer-apply-button"
                  disabled={
                    pending ||
                    (!addMode &&
                      request.mode !== "move_event" &&
                      ((!observationOnly && candidate === null) || validation !== null))
                  }
                >
                  {addMode && composer.drafts.length > 1
                    ? `${String(composer.drafts.length)}개 행 한 번에 반영`
                    : "작업 사본에 즉시 반영"}
                </button>
              </div>
            )}
          </footer>
        </form>
      </section>
    </dialog>,
    document.body,
  );
}

function canonicalIndexForRequest(document: StagingGameDocumentV2, request: DrawerRequest): number {
  if (request.mode === "add_event") {
    if (request.beforeEventId === null) return document.events.length;
    const index = document.events.findIndex(
      (event) => event.identity.eventId === request.beforeEventId,
    );
    return index < 0 ? document.events.length : index;
  }
  const index = document.events.findIndex((event) => event.identity.eventId === request.eventId);
  return index < 0 ? document.events.length : index;
}

function relayTextSuggestion(
  document: StagingGameDocumentV2,
  event: StagingRelayEvent,
  canonicalIndex: number,
  events: readonly StagingRelayEvent[] = document.events,
): string {
  const players = [...document.rosters.away.players, ...document.rosters.home.players];
  const player = (playerId: string) => players.find((item) => item.playerId === playerId);
  const pitchOrdinal =
    event.kind === "pitch" ? pitchOrdinalAt(events, canonicalIndex, event) : undefined;
  return suggestedRelayText(event, {
    playerName: (playerId) => player(playerId)?.name,
    battingOrder: (playerId) => player(playerId)?.battingOrder,
    ...(pitchOrdinal === undefined ? {} : { pitchOrdinal }),
  });
}

function focusInvalidEditorField(form: HTMLFormElement | null, error: string | null): void {
  const selector =
    error?.startsWith("회는") === true
      ? '[data-editor-field="inning"]'
      : error?.startsWith("중계 문구") === true
        ? '[data-editor-field="relay-text"]'
        : error?.startsWith("필수 선수") === true
          ? '.player-picker [role="combobox"]'
          : error?.startsWith("연결할 타석 결과") === true
            ? '[data-editor-field="plate-result-reference"]'
            : error?.startsWith("판독 대상") === true
              ? '[data-editor-field="review-reference"]'
              : error?.startsWith("원천 타입") === true
                ? '[data-editor-field="source-type"]'
                : ".command-editor > label select:not(:disabled)";
  form?.querySelector<HTMLElement>(selector)?.focus();
}
