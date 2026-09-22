import type { ObservedState, PitchCall, Side, StagingRelayEvent } from "@kbo/contracts";

import type { SourceFinding } from "../types.js";
import type { ParseDecision } from "./decision.js";
import {
  administrativeCode,
  battedBallTypeDecision,
  battingOrderFromPosition,
  buntDecision,
  independentReasonDecision,
  incomingFieldPosition,
  inferredBatterDestination,
  kindDecision,
  pitchCallDecision,
  pitchCallMatchesAward,
  plateResultDecision,
  resultAllowsBattedBall,
  reviewDecision,
  runnerDestination,
  runnerFromBase,
  runnerOutKind,
  runnerOutcomeDecision,
  substitutionRole,
  substitutionSegments,
  textIndicatesFieldingSide,
  textIndicatesPositionChange,
} from "./lexicon.js";
import type { CanonicalNaverRow, ParseContext } from "./model.js";
import { pendingPitchClockAward } from "./normalization-context.js";
import { parseNaverPitchMetadata } from "./pitch-metadata.js";
import {
  battingOrderForPlayer,
  battingSide,
  opposite,
  resolveBatter,
  resolvePitcher,
  resolveRunner,
  resolveSubstitutionPlayers,
} from "./player-resolver.js";

export interface EmittedRelayRow {
  readonly event: StagingRelayEvent;
  readonly findings: readonly SourceFinding[];
}

export function emitRelayRow(
  gameId: string,
  row: CanonicalNaverRow,
  context: ParseContext,
): EmittedRelayRow {
  const base = eventBase(gameId, row, context);
  const kind = kindDecision(row);
  if (kind.status !== "matched") {
    return unresolvedRow(base, row, "classification", kind);
  }
  if (kind.value === "unresolved") {
    return unresolvedRow(base, row, "classification", {
      status: "unresolved",
      ruleId: "kind.explicit_unresolved",
      reason: "원천이 이 행을 unresolved로 표시했습니다.",
      evidence: kind.evidence,
    });
  }
  if (kind.value === "half_inning_start") {
    return { event: { ...base, kind: kind.value, payload: {} }, findings: [] };
  }
  if (kind.value === "batter_start") {
    const batter = resolveBatter(row, context);
    if (batter.status !== "matched") return unresolvedRow(base, row, "entity", batter, kind.value);
    const pitcher = resolvePitcher(row, context);
    if (pitcher.status !== "matched") {
      return unresolvedRow(base, row, "entity", pitcher, kind.value);
    }
    return {
      event: {
        ...base,
        kind: kind.value,
        payload: { batterId: batter.value, pitcherId: pitcher.value },
      },
      findings: [],
    };
  }
  if (kind.value === "pitch") {
    return emitPitch(base, row, context);
  }
  if (kind.value === "plate_result") {
    return emitPlateResult(base, row, context);
  }
  if (kind.value === "runner_advance") {
    return emitRunnerAdvance(base, row, context);
  }
  if (kind.value === "substitution") {
    return emitSubstitution(base, row, context);
  }
  if (kind.value === "review") {
    const decision = reviewDecision(row);
    return {
      event: {
        ...base,
        kind: kind.value,
        payload: {
          ...(decision.status === "matched" ? { decision: decision.value } : {}),
          ...(row.reviewedEventId === null ? {} : { reviewedEventId: row.reviewedEventId }),
        },
      },
      findings: [],
    };
  }
  return {
    event: {
      ...base,
      kind: "administrative",
      payload: { code: administrativeCode(row) },
    },
    findings: [],
  };
}

function emitPitch(
  base: EventBase,
  row: CanonicalNaverRow,
  context: ParseContext,
): EmittedRelayRow {
  const callDecision = pitchCallDecision(row);
  if (callDecision.status !== "matched") {
    return unresolvedRow(base, row, "semantic", callDecision, "pitch");
  }
  const pendingAward = pendingPitchClockAward(row, context);
  const call: PitchCall =
    row.sourcePitchId === null &&
    pendingAward !== null &&
    pitchCallMatchesAward(callDecision.value, pendingAward)
      ? pendingAward
      : callDecision.value;
  const batter = resolveBatter(row, context);
  const pitcher = resolvePitcher(row, context);
  if (hasExplicitBatterEvidence(row) && batter.status !== "matched") {
    return unresolvedRow(base, row, "entity", batter, "pitch");
  }
  if (hasExplicitPitcherEvidence(row) && pitcher.status !== "matched") {
    return unresolvedRow(base, row, "entity", pitcher, "pitch");
  }
  const metadata = parseNaverPitchMetadata(row.pitchSpeed, row.pitchType, {
    endpoint: row.source.endpoint,
    blockIndex: row.source.endpointBlockIndex,
    rowIndex: row.rawIndex,
    eventId: base.identity.eventId,
    ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
    ...(row.relayText === null ? {} : { sourceText: row.relayText }),
  });
  const event: Extract<StagingRelayEvent, { kind: "pitch" }> = {
    ...base,
    kind: "pitch",
    payload: {
      call,
      ...metadata.metadata,
      ...(row.sourcePitchId === null ? {} : { sourcePitchId: row.sourcePitchId }),
      ...(batter.status === "matched" ? { batterId: batter.value } : {}),
      ...(pitcher.status === "matched" ? { pitcherId: pitcher.value } : {}),
    },
  };
  if (row.sourcePitchId !== null) {
    const byId =
      context.pitchEventIdsByBlock.get(row.source.sourceBlockIndex) ?? new Map<string, string[]>();
    const candidates = byId.get(row.sourcePitchId) ?? [];
    candidates.push(event.identity.eventId);
    byId.set(row.sourcePitchId, candidates);
    context.pitchEventIdsByBlock.set(row.source.sourceBlockIndex, byId);
  }
  return { event, findings: metadata.findings };
}

function emitPlateResult(
  base: EventBase,
  row: CanonicalNaverRow,
  context: ParseContext,
): EmittedRelayRow {
  const result = plateResultDecision(row);
  if (result.status !== "matched")
    return unresolvedRow(base, row, "semantic", result, "plate_result");
  const batter = resolveBatter(row, context);
  if (batter.status !== "matched")
    return unresolvedRow(base, row, "entity", batter, "plate_result");
  const pitcher = resolvePitcher(row, context);
  if (pitcher.status !== "matched") {
    return unresolvedRow(base, row, "entity", pitcher, "plate_result");
  }
  const battedBall = battedBallTypeDecision(row.relayText);
  const bunt = buntDecision(row.relayText);
  const acceptsBattedBall = resultAllowsBattedBall(result.value);
  const battedBallType =
    result.value === "sacrifice_fly"
      ? battedBall.status === "matched"
        ? battedBall.value
        : "fly_ball"
      : battedBall.status === "matched"
        ? battedBall.value
        : undefined;
  const isBunt = !acceptsBattedBall
    ? undefined
    : result.value === "sacrifice_bunt"
      ? true
      : result.value === "sacrifice_fly"
        ? false
        : bunt.status === "matched"
          ? true
          : battedBallType === undefined
            ? undefined
            : false;
  const batterDestination =
    row.batterDestination ?? inferredBatterDestination(result.value, row.relayText);
  return {
    event: {
      ...base,
      kind: "plate_result",
      payload: {
        result: result.value,
        batterId: batter.value,
        pitcherId: pitcher.value,
        ...(row.creditedRbi === null ? {} : { creditedRbi: row.creditedRbi }),
        ...(row.outsRecorded === null ? {} : { outsRecorded: row.outsRecorded }),
        ...(batterDestination === null ? {} : { batterDestination }),
        ...(!acceptsBattedBall || battedBallType === undefined ? {} : { battedBallType }),
        ...(isBunt === undefined ? {} : { isBunt }),
      },
    },
    findings: [],
  };
}

function emitRunnerAdvance(
  base: EventBase,
  row: CanonicalNaverRow,
  context: ParseContext,
): EmittedRelayRow {
  const fromBase = row.fromBase ?? runnerFromBase(row.relayText);
  if (fromBase === null) {
    return unresolvedRow(
      base,
      row,
      "semantic",
      missing("runner.from_base_missing", "출발 베이스가 없습니다."),
      "runner_advance",
    );
  }
  const outcome = runnerOutcomeDecision(row);
  if (outcome.status !== "matched") {
    return unresolvedRow(base, row, "semantic", outcome, "runner_advance");
  }
  const toBase = row.toBase ?? runnerDestination(row.relayText, fromBase, outcome.value);
  if (toBase === null) {
    return unresolvedRow(
      base,
      row,
      "semantic",
      missing("runner.to_base_missing", "도착 베이스가 없습니다."),
      "runner_advance",
    );
  }
  const runner = resolveRunner(row, fromBase, toBase, outcome.value, context);
  if (runner.status !== "matched")
    return unresolvedRow(base, row, "entity", runner, "runner_advance");
  const reason = independentReasonDecision(row);
  const latestResult = context.latestPlateResult[`${String(row.inning)}:${row.half}`] ?? null;
  if (row.plateResultEventId === null && latestResult === null && reason.status !== "matched") {
    return unresolvedRow(
      base,
      row,
      "link",
      reason.status === "unresolved"
        ? reason
        : missing("runner.context_missing", "연결할 타석 결과나 독립 주자 이동 사유가 없습니다."),
      "runner_advance",
    );
  }
  return {
    event: {
      ...base,
      kind: "runner_advance",
      payload: {
        runnerId: runner.value,
        fromBase,
        toBase,
        outcome: outcome.value,
        ...(outcome.value === "out" ? { outKind: runnerOutKind(row.relayText) } : {}),
        ...(row.supersedesThirdOut ? { supersedesThirdOut: true } : {}),
        ...(row.responsiblePitcherId === null
          ? {}
          : { responsiblePitcherId: row.responsiblePitcherId }),
        context:
          row.plateResultEventId !== null
            ? { kind: "plate_result", plateResultEventId: row.plateResultEventId }
            : latestResult !== null
              ? { kind: "plate_result", plateResultEventId: latestResult }
              : {
                  kind: "independent",
                  reason: reason.status === "matched" ? reason.value : "other",
                },
      },
    },
    findings: [],
  };
}

function emitSubstitution(
  base: EventBase,
  row: CanonicalNaverRow,
  context: ParseContext,
): EmittedRelayRow {
  const segments = substitutionSegments(row.relayText);
  const roleHint =
    row.playerChange.incomingPosition ??
    row.roleHint ??
    incomingFieldPosition(row.relayText) ??
    segments?.incoming ??
    "";
  const positionChange =
    row.playerChange.type === "shift" || textIndicatesPositionChange(row.relayText);
  const role = substitutionRole(roleHint, row.relayText, positionChange);
  const structuredSide =
    (row.incomingPlayerId === null
      ? undefined
      : context.players.sideById.get(row.incomingPlayerId)) ??
    (row.outgoingPlayerId === null
      ? undefined
      : context.players.sideById.get(row.outgoingPlayerId));
  const side: Side =
    row.side ??
    structuredSide ??
    (role === "pitcher" || role === "fielder" || textIndicatesFieldingSide(row.relayText)
      ? opposite(battingSide(row.half))
      : battingSide(row.half));
  const resolved = resolveSubstitutionPlayers(row, side, role, context);
  if (resolved.incoming.status !== "matched") {
    return unresolvedRow(base, row, "entity", resolved.incoming, "substitution");
  }
  if (resolved.outgoing.status === "unresolved") {
    return unresolvedRow(base, row, "entity", resolved.outgoing, "substitution");
  }
  const outgoingPlayerId =
    resolved.outgoing.status === "matched" && resolved.outgoing.value !== resolved.incoming.value
      ? resolved.outgoing.value
      : undefined;
  const battingOrder =
    row.playerChange.battingOrder ??
    battingOrderFromPosition(row.playerChange.outgoingPosition) ??
    battingOrderForPlayer(context.players, side, outgoingPlayerId ?? null);
  const fieldPosition =
    row.fieldPosition ?? row.playerChange.incomingPosition ?? incomingFieldPosition(row.relayText);
  return {
    event: {
      ...base,
      kind: "substitution",
      payload: {
        side,
        role,
        incomingPlayerId: resolved.incoming.value,
        ...(outgoingPlayerId === undefined ? {} : { outgoingPlayerId }),
        ...(battingOrder === null ? {} : { battingOrder }),
        ...(fieldPosition === null ? {} : { fieldPosition }),
      },
    },
    findings: [],
  };
}

function unresolvedRow(
  base: EventBase,
  row: CanonicalNaverRow,
  stage: "classification" | "semantic" | "entity" | "link",
  decision: Exclude<ParseDecision<unknown>, { readonly status: "matched" }>,
  suspectedKind?: Exclude<StagingRelayEvent["kind"], "unresolved">,
): EmittedRelayRow {
  const ruleId = decision.status === "unresolved" ? decision.ruleId : `${stage}.not_applicable`;
  const reason =
    decision.status === "unresolved" ? decision.reason : "적용할 수 있는 규칙이 없습니다.";
  const event: Extract<StagingRelayEvent, { kind: "unresolved" }> = {
    ...base,
    kind: "unresolved",
    payload: {
      sourceType: row.sourceType,
      ...(suspectedKind === undefined ? {} : { suspectedKind }),
    },
  };
  return {
    event,
    findings: [
      sourceFinding(row, event.identity.eventId, `source.relay.${stage}.${ruleId}`, reason),
    ],
  };
}

function eventBase(gameId: string, row: CanonicalNaverRow, context: ParseContext): EventBase {
  const observedStateAfter = observedState(row, context);
  return {
    identity: {
      kind: "source",
      eventId: `${gameId}:${row.source.endpoint}:${String(row.source.endpointBlockIndex)}:${String(row.rawIndex)}`,
      endpoint: row.source.endpoint,
      blockIndex: row.source.endpointBlockIndex,
      eventIndex: row.rawIndex,
      ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
    },
    sequence: 0,
    inning: row.inning,
    half: row.half,
    ...(row.relayText === null ? {} : { relayText: row.relayText }),
    ...(observedStateAfter === undefined ? {} : { observedStateAfter }),
  };
}

function observedState(row: CanonicalNaverRow, context: ParseContext): ObservedState | undefined {
  const source = row.observedState;
  const bases = source.bases.map((base) => observedBase(base, context)) as [
    string | boolean | null,
    string | boolean | null,
    string | boolean | null,
  ];
  const observed: ObservedState = {
    ...(source.balls === null ? {} : { balls: source.balls }),
    ...(source.strikes === null ? {} : { strikes: source.strikes }),
    ...(source.outs === null ? {} : { outs: source.outs }),
    ...(source.hasBases ? { bases } : {}),
    ...(source.awayScore === null ? {} : { awayScore: source.awayScore }),
    ...(source.homeScore === null ? {} : { homeScore: source.homeScore }),
  };
  return Object.keys(observed).length === 0 ? undefined : observed;
}

function observedBase(value: unknown, context: ParseContext): string | boolean | null {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === "0" ||
    value === ""
  ) {
    return false;
  }
  if (typeof value === "string" || typeof value === "number") {
    const id = String(value).trim();
    return context.players.sideById.has(id) ? id : true;
  }
  return true;
}

function sourceFinding(
  row: CanonicalNaverRow,
  eventId: string,
  code: string,
  message: string,
): SourceFinding {
  return {
    lifecycle: "while_event_unresolved",
    code,
    severity: "blocking",
    message,
    endpoint: row.source.endpoint,
    eventId,
    blockIndex: row.source.endpointBlockIndex,
    rowIndex: row.rawIndex,
    ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
    ...(row.relayText === null ? {} : { sourceText: row.relayText }),
  };
}

function missing(
  ruleId: string,
  reason: string,
): Extract<ParseDecision<never>, { readonly status: "unresolved" }> {
  return { status: "unresolved", ruleId, reason, evidence: [] };
}

function hasExplicitBatterEvidence(row: CanonicalNaverRow): boolean {
  return row.batterId !== null || row.observedState.batterId !== null;
}

function hasExplicitPitcherEvidence(row: CanonicalNaverRow): boolean {
  return row.pitcherId !== null || row.observedState.pitcherId !== null;
}

type EventBase = Omit<StagingRelayEvent, "kind" | "payload">;
