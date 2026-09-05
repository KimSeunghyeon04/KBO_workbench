import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CorrectionCommand,
  CorrectionEventContext,
  CorrectionSession,
  Half,
  Side,
  StagingGameDocumentV2,
  StagingRelayEvent,
  StagingRelayEventKind,
} from "@kbo/contracts";

import { pitchOrdinalAt, suggestedRelayText } from "../events/relay-text";
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
  type AddEventDraft,
  type DraftValidation,
} from "./event-add-composer";
import {
  eventFromForm,
  EVENT_KINDS,
  newCommandId,
  plateResultAllowsBattedBall,
  PITCH_CALLS,
  PLATE_RESULTS,
  resultDefaults,
  RUNNER_OUT_KINDS,
  RUNNER_REASONS,
  validateForm,
  type DrawerRequest,
  type FormState,
} from "./event-editor-registry";
import {
  autofillReason,
  buildEditorAutofillContext,
  initialEditorModel,
  invalidateContextAssignments,
  manualFormPatch,
  modelForKind,
  queuedPlateResultModel,
  queuedReviewTargetModel,
  runnerBaseModel,
  runnerContextModel,
  runnerDestinationModel,
  runnerOutcomeModel,
  runnerPlayerModel,
  substitutionOutgoingModel,
  substitutionRoleModel,
  substitutionSideModel,
  type AutofillAssignments,
  type EditorAutofillContext,
  type EditorFormModel,
} from "./event-editor-autofill";
import { eventKindLabel } from "./event-presentation";
import { PlayerPicker, playerSideForRole } from "./player-picker";

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
    updateEditor(manualFormPatch(editor, patch));
    setDirty(true);
    setConfirmDiscard(false);
    setComposerError(null);
  };
  const updateModel = (transform: (current: EditorFormModel) => EditorFormModel): void => {
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
        : validateForm(form, gameDocument);
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
    if (candidate === null || validation !== null) return;
    onApply({
      commandId: newCommandId(),
      kind: "replace_event",
      eventId: request.eventId,
      event: candidate,
    });
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
                      (candidate === null || validation !== null))
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

function DrawerHeader({
  title,
  titleId,
  descriptionId,
  pending,
  onClose,
}: {
  readonly title: string;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly pending: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <header className="correction-drawer-header">
      <div>
        <span>평면 중계 원장</span>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>구조화 입력은 서버 전체 compile 후 작업 사본에 반영됩니다.</p>
      </div>
      <button
        type="button"
        className="drawer-close-button"
        aria-label="닫기"
        disabled={pending}
        onClick={onClose}
      >
        ×
      </button>
    </header>
  );
}

function AddEventQueue({
  drafts,
  validations,
  activeDraftId,
  announcement,
  pending,
  onSelect,
  onMove,
  onRemove,
}: {
  readonly drafts: readonly AddEventDraft[];
  readonly validations: readonly DraftValidation[];
  readonly activeDraftId: string;
  readonly announcement: string;
  readonly pending: boolean;
  readonly onSelect: (draftId: string) => void;
  readonly onMove: (draftId: string, direction: -1 | 1) => void;
  readonly onRemove: (draftId: string) => void;
}): React.JSX.Element {
  const validationById = new Map(
    validations.map((validation) => [validation.draft.draftId, validation] as const),
  );
  return (
    <section className="event-add-queue" aria-labelledby="event-add-queue-title">
      <header>
        <div>
          <strong id="event-add-queue-title">추가할 행</strong>
          <span>
            {String(drafts.length)} / {String(MAX_EVENT_DRAFTS)}
          </span>
        </div>
        <p aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
      </header>
      <ol>
        {drafts.map((draft, index) => {
          const validation = validationById.get(draft.draftId);
          const active = draft.draftId === activeDraftId;
          return (
            <li key={draft.draftId} className={active ? "is-active" : undefined}>
              <button
                type="button"
                className="event-add-draft-select"
                aria-current={active ? "step" : undefined}
                onClick={() => onSelect(draft.draftId)}
              >
                <span>{String(index + 1)}</span>
                <span>
                  <strong>{eventKindLabel(draft.editor.form.kind)}</strong>
                  <small>{draft.editor.form.relayText.trim() || "중계 문구 미입력"}</small>
                </span>
                {validation?.error === null && validation.event !== null ? (
                  <em>준비됨</em>
                ) : (
                  <em className="has-error">확인 필요</em>
                )}
              </button>
              <div className="event-add-draft-actions">
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 위로 이동`}
                  disabled={pending || index === 0}
                  onClick={() => onMove(draft.draftId, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 아래로 이동`}
                  disabled={pending || index === drafts.length - 1}
                  onClick={() => onMove(draft.draftId, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`${String(index + 1)}번 행 삭제`}
                  disabled={pending || drafts.length === 1}
                  onClick={() => onRemove(draft.draftId)}
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EventFields({
  form,
  assignments,
  update,
  updateModel,
  document,
  context,
  referenceEvents,
  queuedEvents,
}: {
  readonly form: FormState;
  readonly assignments: AutofillAssignments;
  readonly update: (patch: Partial<FormState>) => void;
  readonly updateModel: (transform: (current: EditorFormModel) => EditorFormModel) => void;
  readonly document: StagingGameDocumentV2;
  readonly context: EditorAutofillContext;
  readonly referenceEvents: readonly StagingRelayEvent[];
  readonly queuedEvents: readonly StagingRelayEvent[];
}): React.JSX.Element {
  const batterSide = playerSideForRole(form.half, "batter");
  const pitcherSide = playerSideForRole(form.half, "pitcher");
  const inheritedState = contextStateForForm(form, context, context.state);
  const runnerState = contextStateForForm(form, context, context.runnerState);
  if (form.kind === "half_inning_start")
    return <p className="muted-text">상태 필드가 없는 원천 경계 행입니다.</p>;
  if (form.kind === "batter_start")
    return (
      <>
        <PlayerPicker
          label="타자"
          helperText={autoHint(autofillReason(assignments, "batterId"))}
          document={document}
          side={batterSide}
          value={form.batterId}
          onChange={(batterId) => update({ batterId })}
        />
        <PlayerPicker
          label="투수"
          helperText={autoHint(autofillReason(assignments, "pitcherId"))}
          document={document}
          side={pitcherSide}
          value={form.pitcherId}
          onChange={(pitcherId) => update({ pitcherId })}
        />
      </>
    );
  if (form.kind === "pitch")
    return (
      <>
        <label>
          판정
          <select value={form.call} onChange={(event) => update({ call: event.target.value })}>
            {PITCH_CALLS.map((item) => (
              <option key={item} value={item}>
                {item.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          구속 km/h (선택)
          <input
            type="number"
            min="0"
            step="any"
            value={form.speedKph}
            onChange={(event) => update({ speedKph: event.target.value })}
          />
        </label>
        <label>
          구종 (선택)
          <input
            value={form.pitchType}
            maxLength={100}
            onChange={(event) => update({ pitchType: event.target.value })}
          />
        </label>
        <label>
          원천 투구 ID (선택)
          <input
            value={form.sourcePitchId}
            onChange={(event) => update({ sourcePitchId: event.target.value })}
            placeholder="Naver가 제공한 경우에만"
          />
        </label>
        <PlayerPicker
          label="타자 (선택)"
          optionalLabel={inheritedPlayerLabel(
            document,
            batterSide,
            inheritedState?.batterId,
            "타자",
          )}
          document={document}
          side={batterSide}
          value={form.batterId}
          onChange={(batterId) => update({ batterId })}
        />
        <PlayerPicker
          label="투수 (선택)"
          optionalLabel={inheritedPlayerLabel(
            document,
            pitcherSide,
            inheritedState?.pitcherId,
            "투수",
          )}
          document={document}
          side={pitcherSide}
          value={form.pitcherId}
          onChange={(pitcherId) => update({ pitcherId })}
        />
      </>
    );
  if (form.kind === "plate_result")
    return (
      <>
        <label>
          타석 결과
          <select
            value={form.result}
            onChange={(event) => update(resultDefaults(event.target.value))}
          >
            {PLATE_RESULTS.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <PlayerPicker
          label="타자"
          helperText={autoHint(autofillReason(assignments, "batterId"))}
          document={document}
          side={batterSide}
          value={form.batterId}
          onChange={(batterId) => update({ batterId })}
        />
        <PlayerPicker
          label="투수"
          helperText={autoHint(autofillReason(assignments, "pitcherId"))}
          document={document}
          side={pitcherSide}
          value={form.pitcherId}
          onChange={(pitcherId) => update({ pitcherId })}
        />
        <div className="form-grid three">
          <label>
            타점 (선택)
            <input
              type="number"
              min="0"
              max="4"
              value={form.creditedRbi}
              onChange={(event) => update({ creditedRbi: event.target.value })}
            />
          </label>
          <label>
            직접 기록 아웃 (선택)
            <input
              type="number"
              min="0"
              max="3"
              value={form.outsRecorded}
              onChange={(event) => update({ outsRecorded: event.target.value })}
            />
          </label>
          <label>
            타자 생존 도착 베이스
            <select
              value={form.batterDestination}
              onChange={(event) => update({ batterDestination: event.target.value })}
            >
              <option value="">{defaultBatterDestinationLabel(form.result)}</option>
              <option value="1">1루</option>
              <option value="2">2루</option>
              <option value="3">3루</option>
            </select>
          </label>
        </div>
        {plateResultAllowsBattedBall(form.result) ? (
          <div className="form-grid two">
            <label>
              타구 유형
              <select
                value={form.battedBallType}
                onChange={(event) => update({ battedBallType: event.target.value })}
              >
                <option value="">미확정</option>
                <option value="ground_ball">땅볼</option>
                <option value="fly_ball">뜬공</option>
                <option value="line_drive">직선타</option>
                <option value="popup">내야 뜬공</option>
              </select>
            </label>
            <label>
              번트 여부
              <select
                value={form.isBunt}
                onChange={(event) => update({ isBunt: event.target.value })}
              >
                <option value="">미확정</option>
                <option value="false">번트 아님</option>
                <option value="true">번트</option>
              </select>
            </label>
          </div>
        ) : null}
        <p className="muted-text">
          주자 이동은 이 결과 안에 넣지 않습니다. 별도 원장 행으로 추가하고 결과에 연결하세요.
        </p>
      </>
    );
  if (form.kind === "runner_advance")
    return (
      <>
        <PlayerPicker
          label="주자"
          helperText={autoHint(autofillReason(assignments, "runnerId"))}
          document={document}
          side={batterSide}
          value={form.runnerId}
          prioritizedPlayerIds={runnerState?.bases ?? []}
          onChange={(runnerId) =>
            updateModel((current) => runnerPlayerModel(current, runnerId, context))
          }
        />
        <div className="form-grid three">
          <label>
            출발
            <select
              value={form.fromBase}
              onChange={(event) => {
                const fromBase = event.target.value;
                updateModel((current) => runnerBaseModel(current, fromBase, context));
              }}
            >
              {[1, 2, 3].map((item) => (
                <option value={item} key={item}>
                  {item === 0 ? "타자" : `${String(item)}루`}
                </option>
              ))}
            </select>
            <AutofillHint reason={autofillReason(assignments, "fromBase")} />
          </label>
          <label>
            도착
            <select
              value={form.toBase}
              onChange={(event) => {
                const toBase = event.target.value;
                updateModel((current) => runnerDestinationModel(current, toBase));
              }}
            >
              {[1, 2, 3, 4].map((item) => (
                <option value={item} key={item}>
                  {item === 4 ? "홈" : `${String(item)}루`}
                </option>
              ))}
            </select>
            <AutofillHint reason={autofillReason(assignments, "toBase")} />
          </label>
          <label>
            결과
            <select
              value={form.outcome}
              onChange={(event) => {
                const outcome = event.target.value;
                updateModel((current) => runnerOutcomeModel(current, outcome));
              }}
            >
              <option value="safe">진루</option>
              <option value="out">아웃</option>
              <option value="scored">득점</option>
            </select>
            <AutofillHint reason={autofillReason(assignments, "outcome")} />
          </label>
        </div>
        {form.outcome === "out" ? (
          <label>
            아웃 종류
            <select
              value={form.outKind}
              onChange={(event) => update({ outKind: event.target.value })}
            >
              {RUNNER_OUT_KINDS.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <PlayerPicker
          label="책임 투수 (선택)"
          optionalLabel="자동(현재 책임 투수)"
          document={document}
          side={pitcherSide}
          value={form.responsiblePitcherId}
          onChange={(responsiblePitcherId) => update({ responsiblePitcherId })}
        />
        <label>
          연결 방식
          <select
            value={form.contextKind}
            onChange={(event) => {
              const contextKind = event.target.value as FormState["contextKind"];
              updateModel((current) => runnerContextModel(current, contextKind, context));
            }}
          >
            <option value="plate_result">타석 결과에 연결</option>
            <option value="independent">독립 주자 플레이</option>
          </select>
        </label>
        {form.contextKind === "plate_result" ? (
          <label>
            연결할 타석 결과
            <select
              value={form.plateResultEventId}
              data-editor-field="plate-result-reference"
              onChange={(event) => update({ plateResultEventId: event.target.value })}
            >
              <option value="">결과 선택</option>
              {referenceEvents
                .filter((item) => item.kind === "plate_result")
                .map((item) => (
                  <option value={item.identity.eventId} key={item.identity.eventId}>
                    {referenceEventLabel(document, queuedEvents, item)}
                  </option>
                ))}
            </select>
            <AutofillHint reason={autofillReason(assignments, "plateResultEventId")} />
          </label>
        ) : (
          <label>
            독립 사유
            <select
              value={form.reason}
              onChange={(event) => update({ reason: event.target.value })}
            >
              {RUNNER_REASONS.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
        {form.outcome === "out" ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.supersedesThirdOut}
              onChange={(event) => update({ supersedesThirdOut: event.target.checked })}
            />
            제3아웃보다 득점 판정을 우선
          </label>
        ) : null}
      </>
    );
  if (form.kind === "substitution")
    return (
      <>
        <label>
          팀
          <select
            value={form.side}
            onChange={(event) => {
              const side = event.target.value as Side;
              updateModel((current) => substitutionSideModel(current, side, context));
            }}
          >
            <option value="away">{document.teams.away.name}</option>
            <option value="home">{document.teams.home.name}</option>
          </select>
          <AutofillHint reason={autofillReason(assignments, "side")} />
        </label>
        <label>
          역할
          <select
            value={form.role}
            onChange={(event) => {
              const role = event.target.value;
              updateModel((current) => substitutionRoleModel(current, role, context));
            }}
          >
            <option value="batter">타자</option>
            <option value="runner">주자</option>
            <option value="pitcher">투수</option>
            <option value="fielder">야수</option>
          </select>
        </label>
        <PlayerPicker
          label="들어오는 선수"
          document={document}
          side={form.side}
          value={form.incomingPlayerId}
          onChange={(incomingPlayerId) => update({ incomingPlayerId })}
        />
        <PlayerPicker
          label="나가는 선수 (선택)"
          optionalLabel="없음"
          helperText={autoHint(autofillReason(assignments, "outgoingPlayerId"))}
          document={document}
          side={form.side}
          value={form.outgoingPlayerId}
          prioritizedPlayerIds={substitutionPriorities(form, inheritedState)}
          onChange={(outgoingPlayerId) =>
            updateModel((current) => substitutionOutgoingModel(current, outgoingPlayerId, context))
          }
        />
        <div className="form-grid two">
          <label>
            타순 (선택)
            <input
              type="number"
              min="1"
              max="9"
              value={form.battingOrder}
              onChange={(event) => update({ battingOrder: event.target.value })}
            />
            <AutofillHint reason={autofillReason(assignments, "battingOrder")} />
          </label>
          <label>
            수비 위치 (선택)
            <input
              value={form.fieldPosition}
              onChange={(event) => update({ fieldPosition: event.target.value })}
            />
          </label>
        </div>
      </>
    );
  if (form.kind === "review")
    return (
      <>
        <label>
          판정
          <select
            value={form.decision}
            onChange={(event) => update({ decision: event.target.value })}
          >
            <option value="">미확정</option>
            <option value="requested">요청</option>
            <option value="upheld">원심 유지</option>
            <option value="overturned">번복</option>
            <option value="inconclusive">판정 불가</option>
          </select>
        </label>
        <label>
          판독 대상 행 (선택)
          <select
            value={form.reviewedEventId}
            data-editor-field="review-reference"
            onChange={(event) => update({ reviewedEventId: event.target.value })}
          >
            <option value="">연결 없음</option>
            {referenceEvents.map((item) => (
              <option key={item.identity.eventId} value={item.identity.eventId}>
                {referenceEventLabel(document, queuedEvents, item)}
              </option>
            ))}
          </select>
          <AutofillHint reason={autofillReason(assignments, "reviewedEventId")} />
        </label>
      </>
    );
  if (form.kind === "administrative")
    return (
      <label>
        안내 종류
        <select
          value={form.adminCode}
          onChange={(event) => update({ adminCode: event.target.value })}
        >
          <option value="announcement">공지</option>
          <option value="mound_visit">마운드 방문</option>
          <option value="break">휴식·중단</option>
          <option value="footer">footer</option>
          <option value="other">기타</option>
        </select>
      </label>
    );
  return (
    <>
      <label>
        정리된 원천 타입
        <input
          value={form.sourceType}
          data-editor-field="source-type"
          onChange={(event) => update({ sourceType: event.target.value })}
        />
      </label>
      <label>
        추정 행 종류
        <select
          value={form.suspectedKind}
          onChange={(event) => update({ suspectedKind: event.target.value })}
        >
          <option value="">추정 없음</option>
          {EVENT_KINDS.filter((item) => item !== "unresolved").map((item) => (
            <option key={item} value={item}>
              {eventKindLabel(item)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted-text">
        원문과 원천 위치는 유지됩니다. 종류를 바꾸면 같은 행을 typed 행으로 교체합니다.
      </p>
    </>
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

function referenceEventLabel(
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

function inheritedPlayerLabel(
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

function contextStateForForm(
  form: FormState,
  context: EditorAutofillContext,
  state: CorrectionEventContext["before"] | undefined,
): CorrectionEventContext["before"] | undefined {
  return Number(form.inning) === context.anchorInning && form.half === context.anchorHalf
    ? state
    : undefined;
}

function substitutionPriorities(
  form: FormState,
  state: CorrectionEventContext["before"] | undefined,
): readonly (string | null | undefined)[] {
  if (form.role === "batter") return [state?.batterId];
  if (form.role === "pitcher") return [state?.pitcherId];
  if (form.role === "runner") return state?.bases ?? [];
  return [];
}

function autoHint(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : `자동 지정 · ${reason}`;
}

function AutofillHint({
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

function defaultBatterDestinationLabel(result: string): string {
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
