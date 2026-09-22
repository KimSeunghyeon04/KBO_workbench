import type {
  CorrectionEventState,
  CorrectionSession,
  Half,
  Side,
  StagingGameDocumentV2,
  StagingRelayEvent,
  StagingRelayEventKind,
} from "@kbo/contracts";

import { formForKind, formFrom, type DrawerRequest, type FormState } from "./event-editor-registry";

export type AutofillField =
  | "batterId"
  | "pitcherId"
  | "runnerId"
  | "fromBase"
  | "toBase"
  | "outcome"
  | "plateResultEventId"
  | "side"
  | "outgoingPlayerId"
  | "battingOrder"
  | "reviewedEventId";

export interface AutofillAssignment {
  readonly reason: string;
  readonly source: "state" | "position" | "role" | "roster" | "relation";
}

export type AutofillAssignments = Partial<Record<AutofillField, AutofillAssignment>>;

export interface EditorFormModel {
  readonly form: FormState;
  readonly assignments: AutofillAssignments;
  readonly notice: string;
}

export interface EditorAutofillContext {
  readonly document: StagingGameDocumentV2;
  readonly insertionIndex: number;
  readonly anchorInning: number | undefined;
  readonly anchorHalf: Half | undefined;
  readonly selectedEvent: StagingRelayEvent | undefined;
  readonly selectedEventContext: CorrectionSession["eventContexts"][number] | undefined;
  readonly state: CorrectionEventState | undefined;
  readonly runnerState: CorrectionEventState | undefined;
  readonly addAfterEvent: StagingRelayEvent | undefined;
  readonly linkablePlateResult: Extract<StagingRelayEvent, { kind: "plate_result" }> | undefined;
  readonly reviewTarget: StagingRelayEvent | undefined;
}

const AUTOFILL_FIELDS: readonly AutofillField[] = [
  "batterId",
  "pitcherId",
  "runnerId",
  "fromBase",
  "toBase",
  "outcome",
  "plateResultEventId",
  "side",
  "outgoingPlayerId",
  "battingOrder",
  "reviewedEventId",
];

const FIELD_LABELS: Readonly<Record<AutofillField, string>> = {
  batterId: "타자",
  pitcherId: "투수",
  runnerId: "주자",
  fromBase: "출발 베이스",
  toBase: "도착 베이스",
  outcome: "주자 결과",
  plateResultEventId: "연결 결과",
  side: "교체 팀",
  outgoingPlayerId: "나가는 선수",
  battingOrder: "타순",
  reviewedEventId: "판독 대상",
};

export function buildEditorAutofillContext(
  session: CorrectionSession,
  request: DrawerRequest,
): EditorAutofillContext {
  const document = session.draftDocument;
  const insertionIndex = canonicalIndexForRequest(document, request);
  const selectedEvent =
    request.mode === "add_event"
      ? request.seedEvent
      : document.events.find((event) => event.identity.eventId === request.eventId);
  const state = stateForRequest(session, request);
  const addAfterEvent = directAddAfterEvent(document, request, insertionIndex);
  const linkablePlateResult = nearestLinkablePlateResult(document, insertionIndex);
  const runnerState =
    linkablePlateResult === undefined
      ? state
      : session.eventContexts.find((item) => item.eventId === linkablePlateResult.identity.eventId)
          ?.before;
  return {
    document,
    insertionIndex,
    anchorInning: selectedEvent?.inning,
    anchorHalf: selectedEvent?.half,
    selectedEvent,
    selectedEventContext:
      request.mode === "replace_event"
        ? session.eventContexts.find((item) => item.eventId === request.eventId)
        : undefined,
    state,
    runnerState,
    addAfterEvent,
    linkablePlateResult,
    reviewTarget: nearestReviewTarget(document, insertionIndex),
  };
}

export function initialEditorModel(
  request: DrawerRequest,
  event: StagingRelayEvent | undefined,
  context: EditorAutofillContext,
): EditorFormModel {
  const form = formFrom(request, event);
  if (event !== undefined || request.mode !== "add_event") return plainModel(form);
  if (context.addAfterEvent?.kind !== "plate_result") return plainModel(form);
  return autofillForKind(
    { ...formForKind({ ...form, relayText: "" }, "runner_advance"), relayText: "" },
    context,
  );
}

export function modelForKind(
  current: FormState,
  kind: StagingRelayEventKind,
  context: EditorAutofillContext,
): EditorFormModel {
  return autofillForKind(formForKind(current, kind), context);
}

export function manualFormPatch(
  current: EditorFormModel,
  patch: Partial<FormState>,
): EditorFormModel {
  return {
    form: { ...current.form, ...patch },
    assignments: removePatchedAssignments(current.assignments, patch),
    notice: "",
  };
}

export function runnerBaseModel(
  current: EditorFormModel,
  fromBase: string,
  context: EditorAutofillContext,
): EditorFormModel {
  // A runner can already have advanced within this play; the before-state is only a suggestion.
  if (current.form.runnerId !== "" && current.assignments.runnerId === undefined)
    return manualFormPatch(current, { fromBase });
  const state = matchingContextState(current.form, context, context.runnerState);
  const base = Number(fromBase);
  const runnerId = base >= 1 && base <= 3 ? (state?.bases[base - 1] ?? "") : "";
  return automaticFormPatch(
    current,
    { fromBase, runnerId },
    runnerId === "" ? {} : { runnerId: assignment(`현재 ${fromBase}루`, "state") },
  );
}

export function runnerPlayerModel(
  current: EditorFormModel,
  runnerId: string,
  context: EditorAutofillContext,
): EditorFormModel {
  if (current.form.fromBase !== "" && current.assignments.fromBase === undefined)
    return manualFormPatch(current, { runnerId });
  const state = matchingContextState(current.form, context, context.runnerState);
  const baseIndex = state?.bases.findIndex((candidate) => candidate === runnerId) ?? -1;
  return automaticFormPatch(
    current,
    { runnerId, ...(baseIndex < 0 ? {} : { fromBase: String(baseIndex + 1) }) },
    baseIndex < 0 ? {} : { fromBase: assignment("현재 베이스", "state") },
  );
}

export function runnerOutcomeModel(current: EditorFormModel, outcome: string): EditorFormModel {
  return automaticFormPatch(
    current,
    {
      outcome,
      ...(outcome === "scored" ? { toBase: "4" } : {}),
      ...(outcome === "out" ? {} : { outKind: "tag", supersedesThirdOut: false }),
    },
    outcome === "scored" ? { toBase: assignment("득점 결과", "relation") } : {},
  );
}

export function runnerDestinationModel(current: EditorFormModel, toBase: string): EditorFormModel {
  if (toBase === "4" && current.form.outcome !== "out")
    return automaticFormPatch(
      current,
      { toBase, outcome: "scored", outKind: "tag", supersedesThirdOut: false },
      { outcome: assignment("홈 도착", "relation") },
    );
  if (toBase !== "4" && current.form.outcome === "scored")
    return automaticFormPatch(
      current,
      { toBase, outcome: "safe", outKind: "tag", supersedesThirdOut: false },
      { outcome: assignment("베이스 도착", "relation") },
    );
  return manualFormPatch(current, { toBase });
}

export function runnerContextModel(
  current: EditorFormModel,
  contextKind: FormState["contextKind"],
  context: EditorAutofillContext,
): EditorFormModel {
  if (contextKind === "independent")
    return manualFormPatch(current, {
      contextKind,
      plateResultEventId: "",
      reason: "other",
    });
  const result = matchingLinkableResult(current.form, context);
  return automaticFormPatch(
    current,
    {
      contextKind,
      reason: "other",
      plateResultEventId: result?.identity.eventId ?? "",
    },
    result === undefined ? {} : { plateResultEventId: assignment("직전 타석 결과", "position") },
  );
}

export function substitutionRoleModel(
  current: EditorFormModel,
  role: FormState["role"],
  context: EditorAutofillContext,
): EditorFormModel {
  return substitutionModel(current.form, role, undefined, context);
}

export function substitutionSideModel(
  current: EditorFormModel,
  side: Side,
  context: EditorAutofillContext,
): EditorFormModel {
  return substitutionModel(current.form, current.form.role, side, context);
}

export function substitutionOutgoingModel(
  current: EditorFormModel,
  outgoingPlayerId: string,
  context: EditorAutofillContext,
): EditorFormModel {
  const order = battingOrderAt(
    context.document,
    current.form.side,
    outgoingPlayerId,
    context.insertionIndex,
  );
  return automaticFormPatch(
    current,
    { outgoingPlayerId, battingOrder: order === undefined ? "" : String(order.value) },
    order === undefined ? {} : { battingOrder: assignment(order.reason, "roster") },
  );
}

export function invalidateContextAssignments(
  current: EditorFormModel,
  patch: Pick<FormState, "inning"> | Pick<FormState, "half">,
  context: EditorAutofillContext,
): EditorFormModel {
  const clear = (field: AutofillField): boolean => {
    const source = current.assignments[field]?.source;
    return source === "state" || source === "position" || source === "roster";
  };
  const clearOutgoing = clear("outgoingPlayerId");
  const cleared = automaticFormPatch(
    current,
    {
      ...patch,
      ...(clear("batterId") ? { batterId: "" } : {}),
      ...(clear("pitcherId") ? { pitcherId: "" } : {}),
      ...(clear("runnerId") ? { runnerId: "" } : {}),
      ...(clear("fromBase") ? { fromBase: "1" } : {}),
      ...(clear("plateResultEventId") ? { plateResultEventId: "" } : {}),
      ...(clearOutgoing ? { outgoingPlayerId: "" } : {}),
      ...(clearOutgoing && current.assignments.battingOrder !== undefined
        ? { battingOrder: "" }
        : {}),
      ...(clear("reviewedEventId") ? { reviewedEventId: "" } : {}),
    },
    {},
  );
  if (!("half" in patch) || cleared.form.kind !== "substitution") return cleared;
  return substitutionModel(cleared.form, cleared.form.role, undefined, context, false);
}

export function autofillReason(
  assignments: AutofillAssignments,
  field: AutofillField,
): string | undefined {
  return assignments[field]?.reason;
}

export function queuedPlateResultModel(
  current: EditorFormModel,
  plateResultEventId: string,
): EditorFormModel {
  return automaticFormPatch(
    current,
    {
      contextKind: "plate_result",
      plateResultEventId,
      reason: "other",
    },
    { plateResultEventId: assignment("앞선 추가 행", "relation") },
  );
}

export function queuedReviewTargetModel(
  current: EditorFormModel,
  reviewedEventId: string,
): EditorFormModel {
  return automaticFormPatch(
    current,
    { reviewedEventId },
    { reviewedEventId: assignment("앞선 추가 행", "relation") },
  );
}

function autofillForKind(form: FormState, context: EditorAutofillContext): EditorFormModel {
  const state = matchingContextState(form, context, context.state);
  if (form.kind === "batter_start") {
    const batter = batterStartBatter(form, context, state);
    const pitcher = batterStartPitcher(form, context, state);
    const patch = {
      ...(batter === undefined ? {} : { batterId: batter.playerId }),
      ...(pitcher === undefined ? {} : { pitcherId: pitcher.playerId }),
    };
    return automaticFormPatch(plainModel(form), patch, {
      ...(batter === undefined ? {} : { batterId: assignment(batter.reason, batter.source) }),
      ...(pitcher === undefined ? {} : { pitcherId: assignment(pitcher.reason, pitcher.source) }),
    });
  }
  if (form.kind === "plate_result") {
    const patch = {
      ...(state?.batterId === null || state?.batterId === undefined
        ? {}
        : { batterId: state.batterId }),
      ...(state?.pitcherId === null || state?.pitcherId === undefined
        ? {}
        : { pitcherId: state.pitcherId }),
    };
    return automaticFormPatch(plainModel(form), patch, {
      ...(patch.batterId === undefined ? {} : { batterId: assignment("현재 타석", "state") }),
      ...(patch.pitcherId === undefined ? {} : { pitcherId: assignment("현재 타석", "state") }),
    });
  }
  if (form.kind === "runner_advance") {
    const result = matchingLinkableResult(form, context);
    const runnerState = matchingContextState(form, context, context.runnerState);
    const occupied = firstOccupiedBase(runnerState);
    return automaticFormPatch(
      plainModel(form),
      {
        ...(result === undefined
          ? {}
          : {
              contextKind: "plate_result" as const,
              plateResultEventId: result.identity.eventId,
            }),
        ...(occupied === undefined
          ? {}
          : { fromBase: String(occupied.base), runnerId: occupied.runnerId }),
      },
      {
        ...(result === undefined
          ? {}
          : { plateResultEventId: assignment("직전 타석 결과", "position") }),
        ...(occupied === undefined
          ? {}
          : {
              fromBase: assignment(`현재 ${String(occupied.base)}루`, "state"),
              runnerId: assignment(`현재 ${String(occupied.base)}루`, "state"),
            }),
      },
    );
  }
  if (form.kind === "substitution") return substitutionModel(form, form.role, undefined, context);
  if (form.kind === "review") {
    const target = matchingReviewTarget(form, context);
    return automaticFormPatch(
      plainModel(form),
      { reviewedEventId: target?.identity.eventId ?? "" },
      target === undefined ? {} : { reviewedEventId: assignment("직전 행", "position") },
    );
  }
  return plainModel(form);
}

function substitutionModel(
  current: FormState,
  role: FormState["role"],
  selectedSide: Side | undefined,
  context: EditorAutofillContext,
  useState = true,
): EditorFormModel {
  const derivedSide = sideForRole(current.half, role);
  const side = selectedSide ?? derivedSide;
  const state = useState ? matchingContextState(current, context, context.state) : undefined;
  const occupied = firstOccupiedBase(state);
  const outgoingPlayerId =
    side !== derivedSide
      ? ""
      : role === "batter"
        ? (state?.batterId ?? "")
        : role === "pitcher"
          ? (state?.pitcherId ?? "")
          : role === "runner"
            ? (occupied?.runnerId ?? "")
            : "";
  const order =
    outgoingPlayerId === "" || (role !== "batter" && role !== "runner")
      ? undefined
      : battingOrderAt(context.document, side, outgoingPlayerId, context.insertionIndex);
  const outgoingReason =
    outgoingPlayerId === ""
      ? undefined
      : role === "runner" && occupied !== undefined
        ? `현재 ${String(occupied.base)}루`
        : role === "pitcher"
          ? "현재 투수"
          : "현재 타자";
  return automaticFormPatch(
    plainModel({
      ...current,
      role,
      side,
      incomingPlayerId: "",
      outgoingPlayerId,
      battingOrder: order === undefined ? "" : String(order.value),
      fieldPosition: "",
    }),
    {},
    {
      ...(selectedSide === undefined ? { side: assignment("역할·초말", "role") } : {}),
      ...(outgoingReason === undefined
        ? {}
        : { outgoingPlayerId: assignment(outgoingReason, "state") }),
      ...(order === undefined ? {} : { battingOrder: assignment(order.reason, "roster") }),
    },
  );
}

function automaticFormPatch(
  current: EditorFormModel,
  patch: Partial<FormState>,
  additions: AutofillAssignments,
): EditorFormModel {
  const assignments = removePatchedAssignments(current.assignments, patch);
  for (const field of AUTOFILL_FIELDS) {
    const value = additions[field];
    if (value !== undefined) assignments[field] = value;
  }
  return {
    form: { ...current.form, ...patch },
    assignments,
    notice: noticeFor(assignments),
  };
}

function removePatchedAssignments(
  current: AutofillAssignments,
  patch: Partial<FormState>,
): AutofillAssignments {
  const next: AutofillAssignments = {};
  for (const field of AUTOFILL_FIELDS) {
    const value = current[field];
    if (!(field in patch) && value !== undefined) next[field] = value;
  }
  return next;
}

function plainModel(form: FormState): EditorFormModel {
  return { form, assignments: {}, notice: "" };
}

function assignment(reason: string, source: AutofillAssignment["source"]): AutofillAssignment {
  return { reason, source };
}

function noticeFor(assignments: AutofillAssignments): string {
  const descriptions = AUTOFILL_FIELDS.flatMap((field) => {
    const value = assignments[field];
    return value === undefined ? [] : [`${FIELD_LABELS[field]}(${value.reason})`];
  });
  return descriptions.length === 0 ? "" : `자동 지정: ${descriptions.join(" · ")}`;
}

function matchingContextState(
  form: FormState,
  context: EditorAutofillContext,
  state: CorrectionEventState | undefined,
): CorrectionEventState | undefined {
  return contextMatches(form, context) ? state : undefined;
}

function matchingLinkableResult(
  form: FormState,
  context: EditorAutofillContext,
): Extract<StagingRelayEvent, { kind: "plate_result" }> | undefined {
  const result = context.linkablePlateResult;
  return result?.inning === Number(form.inning) && result.half === form.half ? result : undefined;
}

function matchingReviewTarget(
  form: FormState,
  context: EditorAutofillContext,
): StagingRelayEvent | undefined {
  const target = context.reviewTarget;
  return target?.inning === Number(form.inning) && target.half === form.half ? target : undefined;
}

function contextMatches(form: FormState, context: EditorAutofillContext): boolean {
  return Number(form.inning) === context.anchorInning && form.half === context.anchorHalf;
}

function firstOccupiedBase(
  state: CorrectionEventState | undefined,
): { readonly base: number; readonly runnerId: string } | undefined {
  if (state === undefined) return undefined;
  for (let index = 0; index < state.bases.length; index += 1) {
    const runnerId = state.bases[index];
    if (runnerId !== null && runnerId !== undefined) return { base: index + 1, runnerId };
  }
  return undefined;
}

interface PlayerAutofillCandidate {
  readonly playerId: string;
  readonly reason: string;
  readonly source: AutofillAssignment["source"];
}

function batterStartBatter(
  form: FormState,
  context: EditorAutofillContext,
  state: CorrectionEventState | undefined,
): PlayerAutofillCandidate | undefined {
  const side = form.half === "top" ? "away" : "home";
  const current = rosterCandidate(context.document, side, state?.batterId, "현재 타석", "state");
  if (current !== undefined) return current;
  const selected = rosterCandidate(
    context.document,
    side,
    eventParticipantId(context.selectedEvent, "batter"),
    "선택 행",
    "position",
  );
  if (selected !== undefined) return selected;
  const preceding = previousActiveBatter(
    context.document,
    context.insertionIndex,
    Number(form.inning),
    form.half,
  );
  if (preceding !== undefined) return preceding;
  return nextLineupBatter(context.document, side, context.insertionIndex);
}

function batterStartPitcher(
  form: FormState,
  context: EditorAutofillContext,
  state: CorrectionEventState | undefined,
): PlayerAutofillCandidate | undefined {
  const side = form.half === "top" ? "home" : "away";
  const current = rosterCandidate(context.document, side, state?.pitcherId, "현재 타석", "state");
  if (current !== undefined) return current;
  const selected = rosterCandidate(
    context.document,
    side,
    eventParticipantId(context.selectedEvent, "pitcher"),
    "선택 행",
    "position",
  );
  if (selected !== undefined) return selected;
  return previousPitcher(
    context.document,
    side,
    context.insertionIndex,
    Number(form.inning),
    form.half,
  );
}

function rosterCandidate(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string | null | undefined,
  reason: string,
  source: AutofillAssignment["source"],
): PlayerAutofillCandidate | undefined {
  if (
    playerId === null ||
    playerId === undefined ||
    !document.rosters[side].players.some((player) => player.playerId === playerId)
  )
    return undefined;
  return { playerId, reason, source };
}

function eventParticipantId(
  event: StagingRelayEvent | undefined,
  role: "batter" | "pitcher",
): string | undefined {
  if (event?.kind === "batter_start" || event?.kind === "plate_result")
    return role === "batter" ? event.payload.batterId : event.payload.pitcherId;
  if (event?.kind === "pitch")
    return role === "batter" ? event.payload.batterId : event.payload.pitcherId;
  return undefined;
}

function previousActiveBatter(
  document: StagingGameDocumentV2,
  insertionIndex: number,
  inning: number,
  half: Half,
): PlayerAutofillCandidate | undefined {
  const side = half === "top" ? "away" : "home";
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (event === undefined || event.inning !== inning || event.half !== half) break;
    if (event.kind === "plate_result" || event.kind === "half_inning_start") break;
    const candidate = rosterCandidate(
      document,
      side,
      eventParticipantId(event, "batter"),
      "직전 행",
      "position",
    );
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function previousPitcher(
  document: StagingGameDocumentV2,
  side: Side,
  insertionIndex: number,
  inning: number,
  half: Half,
): PlayerAutofillCandidate | undefined {
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (event === undefined || event.inning !== inning || event.half !== half) break;
    if (
      event.kind === "substitution" &&
      event.payload.side === side &&
      event.payload.role === "pitcher"
    )
      return rosterCandidate(
        document,
        side,
        event.payload.incomingPlayerId,
        "앞선 교체",
        "position",
      );
    const candidate = rosterCandidate(
      document,
      side,
      eventParticipantId(event, "pitcher"),
      "직전 행",
      "position",
    );
    if (candidate !== undefined) return candidate;
    if (event.kind === "half_inning_start") break;
  }
  return undefined;
}

function nextLineupBatter(
  document: StagingGameDocumentV2,
  side: Side,
  insertionIndex: number,
): PlayerAutofillCandidate | undefined {
  let previousResult: Extract<StagingRelayEvent, { kind: "plate_result" }> | undefined;
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (
      event?.kind === "plate_result" &&
      document.rosters[side].players.some((player) => player.playerId === event.payload.batterId)
    ) {
      previousResult = event;
      break;
    }
  }
  if (previousResult?.kind !== "plate_result") return undefined;
  const resultIndex = document.events.findIndex(
    (event) => event.identity.eventId === previousResult.identity.eventId,
  );
  const previousOrder = battingOrderAt(
    document,
    side,
    previousResult.payload.batterId,
    resultIndex,
  );
  if (previousOrder === undefined) return undefined;
  const lineup = lineupAt(document, side, insertionIndex);
  const orders = [...lineup.keys()].sort((left, right) => left - right);
  const nextOrder = orders.find((order) => order > previousOrder.value) ?? orders[0];
  if (nextOrder === undefined) return undefined;
  const next = lineup.get(nextOrder);
  if (next === undefined) return undefined;
  return {
    playerId: next.playerId,
    reason: next.reason === "앞선 교체 타순" ? next.reason : "명단 다음 타순",
    source: "roster",
  };
}

function lineupAt(
  document: StagingGameDocumentV2,
  side: Side,
  insertionIndex: number,
): Map<number, { readonly playerId: string; readonly reason: "명단 타순" | "앞선 교체 타순" }> {
  const lineup = new Map<
    number,
    { readonly playerId: string; readonly reason: "명단 타순" | "앞선 교체 타순" }
  >();
  for (const player of document.rosters[side].players) {
    if (!player.starter || player.battingOrder === undefined || lineup.has(player.battingOrder))
      continue;
    lineup.set(player.battingOrder, { playerId: player.playerId, reason: "명단 타순" });
  }
  for (const event of document.events.slice(0, insertionIndex)) {
    if (event.kind !== "substitution" || event.payload.side !== side) continue;
    const explicitOrder = event.payload.battingOrder;
    const outgoingOrder = [...lineup.entries()].find(
      ([, player]) => player.playerId === event.payload.outgoingPlayerId,
    )?.[0];
    const order = explicitOrder ?? outgoingOrder;
    if (order === undefined) continue;
    lineup.set(order, {
      playerId: event.payload.incomingPlayerId,
      reason: "앞선 교체 타순",
    });
  }
  return lineup;
}

function battingOrderAt(
  document: StagingGameDocumentV2,
  side: Side,
  playerId: string,
  insertionIndex: number,
): { readonly value: number; readonly reason: "명단 타순" | "앞선 교체 타순" } | undefined {
  const rosterOrder = document.rosters[side].players.find(
    (player) => player.playerId === playerId,
  )?.battingOrder;
  let result:
    { readonly value: number; readonly reason: "명단 타순" | "앞선 교체 타순" } | undefined =
    rosterOrder === undefined ? undefined : { value: rosterOrder, reason: "명단 타순" };
  for (const event of document.events.slice(0, insertionIndex)) {
    if (event.kind !== "substitution" || event.payload.side !== side) continue;
    if (event.payload.outgoingPlayerId === playerId) result = undefined;
    if (event.payload.incomingPlayerId === playerId && event.payload.battingOrder !== undefined)
      result = { value: event.payload.battingOrder, reason: "앞선 교체 타순" };
  }
  return result;
}

function sideForRole(half: Half, role: FormState["role"]): Side {
  const offense: Side = half === "top" ? "away" : "home";
  return role === "batter" || role === "runner" ? offense : offense === "away" ? "home" : "away";
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

function stateForRequest(
  session: CorrectionSession,
  request: DrawerRequest,
): CorrectionEventState | undefined {
  if (request.mode === "replace_event" || request.mode === "move_event")
    return session.eventContexts.find((item) => item.eventId === request.eventId)?.before;
  if (request.beforeEventId !== null)
    return session.eventContexts.find((item) => item.eventId === request.beforeEventId)?.before;
  const lastEvent = session.draftDocument.events.at(-1);
  if (lastEvent === undefined) return undefined;
  return session.eventContexts.find((item) => item.eventId === lastEvent.identity.eventId)?.after;
}

function directAddAfterEvent(
  document: StagingGameDocumentV2,
  request: DrawerRequest,
  insertionIndex: number,
): StagingRelayEvent | undefined {
  if (request.mode !== "add_event" || request.seedEvent === undefined) return undefined;
  const seedIndex = document.events.findIndex(
    (event) => event.identity.eventId === request.seedEvent?.identity.eventId,
  );
  return seedIndex >= 0 && insertionIndex === seedIndex + 1 ? request.seedEvent : undefined;
}

function nearestLinkablePlateResult(
  document: StagingGameDocumentV2,
  insertionIndex: number,
): Extract<StagingRelayEvent, { kind: "plate_result" }> | undefined {
  let expectedId: string | undefined;
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (event === undefined) continue;
    if (event.kind === "review" || event.kind === "administrative") continue;
    if (event.kind === "runner_advance" && event.payload.context.kind === "plate_result") {
      expectedId ??= event.payload.context.plateResultEventId;
      continue;
    }
    if (
      event.kind === "plate_result" &&
      (expectedId === undefined || expectedId === event.identity.eventId)
    )
      return event;
    break;
  }
  return undefined;
}

function nearestReviewTarget(
  document: StagingGameDocumentV2,
  insertionIndex: number,
): StagingRelayEvent | undefined {
  for (let index = insertionIndex - 1; index >= 0; index -= 1) {
    const event = document.events[index];
    if (event === undefined) continue;
    if (["review", "administrative", "unresolved", "half_inning_start"].includes(event.kind))
      continue;
    return event;
  }
  return undefined;
}
