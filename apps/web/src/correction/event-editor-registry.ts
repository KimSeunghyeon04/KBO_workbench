import type {
  Half,
  RunnerAdvanceReason,
  Side,
  StagingGameDocumentV2,
  StagingRelayEvent,
  StagingRelayEventKind,
} from "@kbo/contracts";

export type DrawerRequest =
  | {
      readonly mode: "add_event";
      readonly beforeEventId: string | null;
      readonly seedEvent?: StagingRelayEvent;
    }
  | { readonly mode: "replace_event"; readonly eventId: string }
  | { readonly mode: "move_event"; readonly eventId: string };

export interface FormState {
  readonly kind: StagingRelayEventKind;
  readonly inning: string;
  readonly half: Half;
  readonly relayText: string;
  readonly beforeEventId: string;
  readonly batterId: string;
  readonly pitcherId: string;
  readonly call: string;
  readonly sourcePitchId: string;
  readonly result: string;
  readonly creditedRbi: string;
  readonly outsRecorded: string;
  readonly batterDestination: string;
  readonly battedBallType: string;
  readonly isBunt: string;
  readonly runnerId: string;
  readonly fromBase: string;
  readonly toBase: string;
  readonly outcome: string;
  readonly outKind: string;
  readonly supersedesThirdOut: boolean;
  readonly responsiblePitcherId: string;
  readonly contextKind: "plate_result" | "independent";
  readonly plateResultEventId: string;
  readonly reason: string;
  readonly side: Side;
  readonly role: string;
  readonly incomingPlayerId: string;
  readonly outgoingPlayerId: string;
  readonly battingOrder: string;
  readonly fieldPosition: string;
  readonly decision: string;
  readonly reviewedEventId: string;
  readonly adminCode: string;
  readonly sourceType: string;
  readonly suspectedKind: string;
}

interface EventEditorDefinition {
  readonly defaults: Partial<FormState>;
  readonly requiredPlayers: readonly (keyof Pick<
    FormState,
    "batterId" | "pitcherId" | "runnerId" | "incomingPlayerId"
  >)[];
}

export const EVENT_EDITOR_REGISTRY: Readonly<Record<StagingRelayEventKind, EventEditorDefinition>> =
  {
    half_inning_start: { defaults: {}, requiredPlayers: [] },
    batter_start: { defaults: {}, requiredPlayers: ["batterId", "pitcherId"] },
    pitch: { defaults: { call: "ball" }, requiredPlayers: [] },
    plate_result: {
      defaults: { result: "field_out", isBunt: "false" },
      requiredPlayers: ["batterId", "pitcherId"],
    },
    runner_advance: {
      defaults: { contextKind: "independent", reason: "other" },
      requiredPlayers: ["runnerId"],
    },
    substitution: { defaults: {}, requiredPlayers: ["incomingPlayerId"] },
    review: { defaults: {}, requiredPlayers: [] },
    administrative: { defaults: { adminCode: "announcement" }, requiredPlayers: [] },
    unresolved: { defaults: { sourceType: "unknown" }, requiredPlayers: [] },
  };

export function formFrom(request: DrawerRequest, event: StagingRelayEvent | undefined): FormState {
  const seed = event ?? (request.mode === "add_event" ? request.seedEvent : undefined);
  const base = emptyForm(seed?.inning ?? 1, seed?.half ?? "top");
  if (event === undefined) return base;
  const common = {
    ...base,
    kind: event.kind,
    inning: String(event.inning),
    half: event.half,
    relayText: event.relayText ?? "",
  };
  if (event.kind === "batter_start")
    return { ...common, batterId: event.payload.batterId, pitcherId: event.payload.pitcherId };
  if (event.kind === "pitch")
    return {
      ...common,
      call: event.payload.call,
      sourcePitchId: event.payload.sourcePitchId ?? "",
      batterId: event.payload.batterId ?? "",
      pitcherId: event.payload.pitcherId ?? "",
    };
  if (event.kind === "plate_result")
    return {
      ...common,
      result: event.payload.result,
      batterId: event.payload.batterId,
      pitcherId: event.payload.pitcherId,
      creditedRbi: optionalNumber(event.payload.creditedRbi),
      outsRecorded: optionalNumber(event.payload.outsRecorded),
      batterDestination: optionalNumber(event.payload.batterDestination),
      battedBallType: event.payload.battedBallType ?? "",
      isBunt: event.payload.isBunt === undefined ? "" : String(event.payload.isBunt),
    };
  if (event.kind === "runner_advance")
    return {
      ...common,
      runnerId: event.payload.runnerId,
      fromBase: String(event.payload.fromBase),
      toBase: String(event.payload.toBase),
      outcome: event.payload.outcome,
      outKind: event.payload.outKind ?? "tag",
      supersedesThirdOut: event.payload.supersedesThirdOut ?? false,
      responsiblePitcherId: event.payload.responsiblePitcherId ?? "",
      contextKind: event.payload.context.kind,
      plateResultEventId:
        event.payload.context.kind === "plate_result"
          ? event.payload.context.plateResultEventId
          : "",
      reason: event.payload.context.kind === "independent" ? event.payload.context.reason : "other",
    };
  if (event.kind === "substitution")
    return {
      ...common,
      side: event.payload.side,
      role: event.payload.role,
      incomingPlayerId: event.payload.incomingPlayerId,
      outgoingPlayerId: event.payload.outgoingPlayerId ?? "",
      battingOrder: optionalNumber(event.payload.battingOrder),
      fieldPosition: event.payload.fieldPosition ?? "",
    };
  if (event.kind === "review")
    return {
      ...common,
      decision: event.payload.decision ?? "",
      reviewedEventId: event.payload.reviewedEventId ?? "",
    };
  if (event.kind === "administrative") return { ...common, adminCode: event.payload.code };
  if (event.kind === "unresolved")
    return {
      ...common,
      sourceType: event.payload.sourceType,
      suspectedKind: event.payload.suspectedKind ?? "",
    };
  return common;
}

export function emptyForm(inning: number, half: Half): FormState {
  return {
    kind: "pitch",
    inning: String(inning),
    half,
    relayText: "볼",
    beforeEventId: "",
    batterId: "",
    pitcherId: "",
    call: "ball",
    sourcePitchId: "",
    result: "field_out",
    creditedRbi: "",
    outsRecorded: "",
    batterDestination: "",
    battedBallType: "",
    isBunt: "false",
    runnerId: "",
    fromBase: "1",
    toBase: "2",
    outcome: "safe",
    outKind: "tag",
    supersedesThirdOut: false,
    responsiblePitcherId: "",
    contextKind: "independent",
    plateResultEventId: "",
    reason: "other",
    side: half === "top" ? "away" : "home",
    role: "batter",
    incomingPlayerId: "",
    outgoingPlayerId: "",
    battingOrder: "",
    fieldPosition: "",
    decision: "",
    reviewedEventId: "",
    adminCode: "announcement",
    sourceType: "unknown",
    suspectedKind: "",
  };
}

export function defaultsForKind(kind: StagingRelayEventKind): Partial<FormState> {
  return { kind, ...EVENT_EDITOR_REGISTRY[kind].defaults };
}

export function formForKind(current: FormState, kind: StagingRelayEventKind): FormState {
  const inning = Number(current.inning);
  const reset = emptyForm(Number.isInteger(inning) ? inning : 1, current.half);
  return {
    ...reset,
    ...EVENT_EDITOR_REGISTRY[kind].defaults,
    kind,
    inning: current.inning,
    half: current.half,
    relayText: current.relayText,
    beforeEventId: current.beforeEventId,
  };
}

const NON_BATTED_BALL_RESULTS = new Set([
  "walk",
  "intentional_walk",
  "hit_by_pitch",
  "strikeout",
  "interference",
]);

export function plateResultAllowsBattedBall(result: string): boolean {
  return !NON_BATTED_BALL_RESULTS.has(result);
}

export function resultDefaults(result: string): Partial<FormState> {
  const reset = {
    result,
    creditedRbi: "",
    outsRecorded: "",
    batterDestination: "",
  };
  if (!plateResultAllowsBattedBall(result)) return { ...reset, battedBallType: "", isBunt: "" };
  if (result === "sacrifice_bunt") return { ...reset, isBunt: "true", battedBallType: "" };
  if (result === "sacrifice_fly") return { ...reset, isBunt: "false", battedBallType: "fly_ball" };
  return { ...reset, battedBallType: "", isBunt: "false" };
}

export function eventFromForm(
  form: FormState,
  document: StagingGameDocumentV2,
  original: StagingRelayEvent | undefined,
  manualEventId?: string,
): StagingRelayEvent | null {
  const inning = Number(form.inning);
  const relayText = form.relayText.trim();
  if (!Number.isInteger(inning) || relayText === "") return null;
  const base = {
    identity: original?.identity ?? {
      kind: "manual" as const,
      eventId: manualEventId ?? newManualEventId(),
    },
    sequence: original?.sequence ?? document.events.length,
    inning,
    half: form.half,
    relayText,
  };
  const optional = <T>(value: string, map: (value: string) => T): T | undefined =>
    value.trim() === "" ? undefined : map(value.trim());
  if (form.kind === "half_inning_start") return { ...base, kind: "half_inning_start", payload: {} };
  if (form.kind === "batter_start")
    return {
      ...base,
      kind: "batter_start",
      payload: { batterId: form.batterId, pitcherId: form.pitcherId },
    };
  if (form.kind === "pitch")
    return {
      ...base,
      kind: "pitch",
      payload: {
        call: form.call as Extract<StagingRelayEvent, { kind: "pitch" }>["payload"]["call"],
        ...(optional(form.sourcePitchId, String) === undefined
          ? {}
          : { sourcePitchId: form.sourcePitchId.trim() }),
        ...(form.batterId === "" ? {} : { batterId: form.batterId }),
        ...(form.pitcherId === "" ? {} : { pitcherId: form.pitcherId }),
      },
    };
  if (form.kind === "plate_result") {
    const allowsBattedBall = plateResultAllowsBattedBall(form.result);
    return {
      ...base,
      kind: "plate_result",
      payload: {
        result: form.result as Extract<
          StagingRelayEvent,
          { kind: "plate_result" }
        >["payload"]["result"],
        batterId: form.batterId,
        pitcherId: form.pitcherId,
        ...(form.creditedRbi === "" ? {} : { creditedRbi: Number(form.creditedRbi) }),
        ...(form.outsRecorded === "" ? {} : { outsRecorded: Number(form.outsRecorded) }),
        ...(form.batterDestination === ""
          ? {}
          : { batterDestination: Number(form.batterDestination) }),
        ...(!allowsBattedBall || form.battedBallType === ""
          ? {}
          : {
              battedBallType: form.battedBallType as
                "ground_ball" | "fly_ball" | "line_drive" | "popup",
            }),
        ...(!allowsBattedBall || form.isBunt === "" ? {} : { isBunt: form.isBunt === "true" }),
      },
    };
  }
  if (form.kind === "runner_advance")
    return {
      ...base,
      kind: "runner_advance",
      payload: {
        runnerId: form.runnerId,
        fromBase: Number(form.fromBase),
        toBase: form.outcome === "scored" ? 4 : Number(form.toBase),
        outcome: form.outcome as "safe" | "out" | "scored",
        ...(form.outcome === "out"
          ? {
              outKind: form.outKind as Extract<
                StagingRelayEvent,
                { kind: "runner_advance" }
              >["payload"]["outKind"],
            }
          : {}),
        ...(form.outcome === "out" && form.supersedesThirdOut ? { supersedesThirdOut: true } : {}),
        ...(form.responsiblePitcherId === ""
          ? {}
          : { responsiblePitcherId: form.responsiblePitcherId }),
        context:
          form.contextKind === "plate_result"
            ? { kind: "plate_result", plateResultEventId: form.plateResultEventId }
            : { kind: "independent", reason: form.reason as RunnerAdvanceReason },
      },
    } as StagingRelayEvent;
  if (form.kind === "substitution")
    return {
      ...base,
      kind: "substitution",
      payload: {
        side: form.side,
        role: form.role as "batter" | "runner" | "pitcher" | "fielder",
        incomingPlayerId: form.incomingPlayerId,
        ...(form.outgoingPlayerId === "" ? {} : { outgoingPlayerId: form.outgoingPlayerId }),
        ...(form.battingOrder === "" ? {} : { battingOrder: Number(form.battingOrder) }),
        ...(form.fieldPosition.trim() === "" ? {} : { fieldPosition: form.fieldPosition.trim() }),
      },
    };
  if (form.kind === "review")
    return {
      ...base,
      kind: "review",
      payload: {
        ...(form.decision === ""
          ? {}
          : {
              decision: form.decision as "requested" | "upheld" | "overturned" | "inconclusive",
            }),
        ...(form.reviewedEventId === "" ? {} : { reviewedEventId: form.reviewedEventId }),
      },
    };
  if (form.kind === "administrative")
    return {
      ...base,
      kind: "administrative",
      payload: {
        code: form.adminCode as "announcement" | "mound_visit" | "break" | "footer" | "other",
      },
    };
  return {
    ...base,
    kind: "unresolved",
    payload: {
      sourceType: form.sourceType.trim(),
      ...(form.suspectedKind === ""
        ? {}
        : { suspectedKind: form.suspectedKind as Exclude<StagingRelayEventKind, "unresolved"> }),
    },
  };
}

export function validateForm(
  form: FormState,
  document: StagingGameDocumentV2,
  referenceEvents: readonly StagingRelayEvent[] = document.events,
): string | null {
  const inning = Number(form.inning);
  if (!Number.isInteger(inning) || inning < 1 || inning > 99)
    return "회는 1~99 사이 정수여야 합니다.";
  if (form.relayText.trim().length < 1 || form.relayText.trim().length > 1000)
    return "중계 문구를 1~1,000자로 입력하세요.";
  const missing = EVENT_EDITOR_REGISTRY[form.kind].requiredPlayers.find(
    (field) => form[field] === "",
  );
  if (missing !== undefined) return "필수 선수를 경기 명단에서 선택하세요.";
  if (
    form.kind === "runner_advance" &&
    form.contextKind === "plate_result" &&
    !referenceEvents.some(
      (item) => item.kind === "plate_result" && item.identity.eventId === form.plateResultEventId,
    )
  )
    return "연결할 타석 결과를 선택하세요.";
  if (
    form.kind === "review" &&
    form.reviewedEventId !== "" &&
    !referenceEvents.some((item) => item.identity.eventId === form.reviewedEventId)
  )
    return "판독 대상은 현재 행보다 앞선 원장 행이어야 합니다.";
  if (form.kind === "unresolved" && form.sourceType.trim() === "") return "원천 타입을 입력하세요.";
  return null;
}

export const EVENT_KINDS: readonly StagingRelayEventKind[] = [
  "half_inning_start",
  "batter_start",
  "pitch",
  "plate_result",
  "runner_advance",
  "substitution",
  "review",
  "administrative",
  "unresolved",
];
export const PITCH_CALLS = [
  "ball",
  "called_strike",
  "swinging_strike",
  "foul",
  "foul_bunt",
  "foul_tip",
  "in_play",
  "hit_by_pitch",
  "automatic_ball",
  "automatic_strike",
  "no_pitch",
] as const;
export const PLATE_RESULTS = [
  "single",
  "double",
  "triple",
  "home_run",
  "walk",
  "intentional_walk",
  "hit_by_pitch",
  "strikeout",
  "field_out",
  "sacrifice_bunt",
  "sacrifice_fly",
  "fielder_choice",
  "reached_on_error",
  "interference",
  "double_play",
  "triple_play",
  "other",
] as const;
export const RUNNER_REASONS = [
  "stolen_base",
  "caught_stealing",
  "pickoff",
  "wild_pitch",
  "passed_ball",
  "balk",
  "defensive_indifference",
  "error",
  "appeal",
  "other",
] as const;
export const RUNNER_OUT_KINDS = [
  "force",
  "tag",
  "batter_runner_before_first",
  "strikeout",
  "fly_catch",
  "appeal_force",
  "appeal_time",
  "interference",
  "abandonment",
] as const;

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function newCommandId(source: Pick<Crypto, "getRandomValues"> = crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return `cmd-${uuid(bytes)}`;
}

export function newManualEventId(source: Pick<Crypto, "getRandomValues"> = crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time & 0xff;
    time = Math.floor(time / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return uuid(bytes);
}

function uuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((item) => item.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
