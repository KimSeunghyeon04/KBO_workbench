import { compareCanonicalStrings } from "@kbo/contracts";

import { NaverSourceFormatError } from "../errors.js";
import type {
  CanonicalNaverRow,
  CanonicalPlayerChange,
  CanonicalSourceState,
  NormalizedRelayBlock,
  RelayBlockInput,
} from "./model.js";
import {
  first,
  integer,
  isRecord,
  meaningfulPitchId,
  nonNegativeInteger,
  optionalText,
  parseHalf,
  parseSide,
  record,
  sourceValueFingerprint,
  validInteger,
  type JsonRecord,
} from "./source-values.js";

export function prepareRelayBlocks(
  inputs: readonly RelayBlockInput[],
): readonly NormalizedRelayBlock[] {
  return orderBlocks(inputs).map((block, sourceBlockIndex) => ({
    ...block,
    sourceBlockIndex,
  }));
}

export function decodeRelayRows(
  blocks: readonly NormalizedRelayBlock[],
): readonly CanonicalNaverRow[] {
  return blocks.flatMap((source) => {
    const inning = integer(first(source.block, ["inn", "inning"]));
    const half = parseHalf(first(source.block, ["homeOrAway", "half"]));
    if (inning === null || inning < 1 || inning > 99 || half === null) {
      throw new NaverSourceFormatError(`${source.endpoint}의 이닝/초말 정보가 올바르지 않습니다.`);
    }
    const rawRows = source.block.textOptions ?? source.block.events;
    if (!Array.isArray(rawRows) || rawRows.some((row) => !isRecord(row))) {
      throw new NaverSourceFormatError(`${source.endpoint}.textOptions는 객체 배열이어야 합니다.`);
    }
    return (rawRows as JsonRecord[])
      .map((raw, rawIndex) => decodeRow(source, raw, rawIndex, inning, half))
      .sort(
        (left, right) =>
          (left.sourceSequence ?? left.rawIndex) - (right.sourceSequence ?? right.rawIndex),
      );
  });
}

function decodeRow(
  source: NormalizedRelayBlock,
  raw: JsonRecord,
  rawIndex: number,
  inning: number,
  half: "top" | "bottom",
): CanonicalNaverRow {
  const state = decodeState(raw.currentGameState ?? raw.observed_state_after);
  const playerChange = decodePlayerChange(raw.playerChange);
  const explicitKind = optionalText(raw.kind)?.toLowerCase() ?? null;
  const numericType = integer(raw.type);
  const relayText = optionalText(raw.text);
  const canonical = {
    explicitKind,
    numericType,
    relayText,
    pitchCallCode: optionalText(first(raw, ["call", "pitchResult"]))?.toLowerCase() ?? null,
    pitchSpeed: raw.speed ?? null,
    pitchType: raw.stuff ?? null,
    resultCode: optionalText(first(raw, ["result", "plateResult"]))?.toLowerCase() ?? null,
    outcomeCode: optionalText(raw.outcome)?.toLowerCase() ?? null,
    reasonCode: optionalText(first(raw, ["reason", "runnerReason"]))?.toLowerCase() ?? null,
    sourcePitchId: meaningfulPitchId(
      first(raw, ["source_pitch_id", "sourcePitchId", "ptsPitchId", "pitchId"]),
    ),
    batterId: optionalText(first(raw, ["batter_id", "batterId"])),
    pitcherId: optionalText(first(raw, ["pitcher_id", "pitcherId"])),
    runnerId: optionalText(first(raw, ["runner_id", "runnerId"])),
    fromBase: validInteger(first(raw, ["from_base", "fromBase"]), 1, 3),
    toBase: validInteger(first(raw, ["to_base", "toBase"]), 1, 4),
    plateResultEventId: optionalText(first(raw, ["plateResultEventId", "plate_result_event_id"])),
    creditedRbi: nonNegativeInteger(first(raw, ["rbi", "creditedRbi"])),
    outsRecorded: nonNegativeInteger(first(raw, ["outs_recorded", "outsRecorded"])),
    batterDestination: validInteger(first(raw, ["batter_destination", "batterDestination"]), 1, 3),
    responsiblePitcherId: optionalText(
      first(raw, ["responsible_pitcher_id", "responsiblePitcherId"]),
    ),
    supersedesThirdOut: raw.supersedesThirdOut === true || raw.supersedes_third_out === true,
    side: parseSide(first(raw, ["side", "teamSide"])),
    roleHint: optionalText(first(raw, ["role", "changeType"])),
    fieldPosition: optionalText(first(raw, ["field_position", "fieldPosition", "positionName"])),
    incomingPlayerId:
      optionalText(
        first(raw, ["incoming_player_id", "incomingPlayerId", "inPlayerId", "playerCode"]),
      ) ?? playerChange.incomingPlayerId,
    outgoingPlayerId:
      optionalText(first(raw, ["outgoing_player_id", "outgoingPlayerId", "outPlayerId"])) ??
      playerChange.outgoingPlayerId,
    playerChange,
    reviewDecision: optionalText(raw.decision)?.toLowerCase() ?? null,
    reviewedEventId: optionalText(first(raw, ["reviewedEventId", "reviewed_event_id"])),
    administrativeCode:
      optionalText(first(raw, ["code", "administrativeCode"]))?.toLowerCase() ?? null,
    observedState: state,
  };
  return {
    source,
    rawIndex,
    inning,
    half,
    sourceSequence: integer(first(raw, ["seqno", "seqNo"])),
    sourceEventId: optionalText(first(raw, ["source_event_id", "id", "seqno", "seqNo"])),
    sourceType: explicitKind ?? (numericType === null ? "unknown" : `type:${String(numericType)}`),
    ...canonical,
    semanticFingerprint: sourceValueFingerprint(canonical),
  };
}

function decodeState(value: unknown): CanonicalSourceState {
  const state = record(value);
  return {
    batterId: optionalText(first(state, ["batter", "batterCode", "batterId"])),
    pitcherId: optionalText(first(state, ["pitcher", "pitcherCode", "pitcherId"])),
    balls: integer(first(state, ["ball", "balls"])),
    strikes: integer(first(state, ["strike", "strikes"])),
    outs: integer(first(state, ["out", "outs"])),
    bases: [state.base1, state.base2, state.base3],
    hasBases: ["base1", "base2", "base3"].some((key) => key in state),
    awayScore: integer(first(state, ["awayScore", "away_score"])),
    homeScore: integer(first(state, ["homeScore", "home_score"])),
  };
}

function decodePlayerChange(value: unknown): CanonicalPlayerChange {
  const change = record(value);
  const incoming = record(change.inPlayer);
  const outgoing = record(change.outPlayer);
  const shifted = change.type === "shift" ? record(change.shiftPlayer) : {};
  return {
    type: optionalText(change.type)?.toLowerCase() ?? null,
    incomingPlayerId:
      optionalText(first(incoming, ["playerId", "playerCode", "pcode"])) ??
      optionalText(shifted.playerId),
    incomingPosition: optionalText(first(incoming, ["playerPos", "positionName", "position"])),
    outgoingPlayerId:
      optionalText(first(outgoing, ["playerId", "playerCode", "pcode"])) ??
      optionalText(shifted.playerId),
    outgoingPosition: optionalText(first(outgoing, ["playerPos", "positionName", "position"])),
    battingOrder: validInteger(first(change, ["battingOrder", "batorder"]), 1, 9),
  };
}

function orderBlocks(blocks: readonly RelayBlockInput[]): RelayBlockInput[] {
  return [...blocks].sort((left, right) => {
    const leftInning = integer(first(left.block, ["inn", "inning"])) ?? 0;
    const rightInning = integer(first(right.block, ["inn", "inning"])) ?? 0;
    const leftHalf = parseHalf(first(left.block, ["homeOrAway", "half"]));
    const rightHalf = parseHalf(first(right.block, ["homeOrAway", "half"]));
    return (
      leftInning - rightInning ||
      Number(leftHalf === "bottom") - Number(rightHalf === "bottom") ||
      blockOrder(left) - blockOrder(right) ||
      compareCanonicalStrings(left.endpoint, right.endpoint) ||
      left.endpointBlockIndex - right.endpointBlockIndex
    );
  });
}

function blockOrder(block: RelayBlockInput): number {
  return (
    integer(first(block.block, ["no", "block_index", "blockIndex"])) ?? block.endpointBlockIndex
  );
}
