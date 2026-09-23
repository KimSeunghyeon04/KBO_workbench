import type { StagingGameDocumentV2 } from "@kbo/contracts";

import { NaverSourceFormatError } from "../errors.js";
import type { RawGameBundle } from "../types.js";
import {
  first,
  integer,
  optionalRecords,
  optionalText,
  record,
  requireRecord,
  requireText,
  type JsonRecord,
} from "./source-values.js";

export interface NaverGameMetadata {
  readonly lineup: JsonRecord;
  readonly gameInfo: JsonRecord;
  readonly gameDate: string;
  readonly scheduledAt: string;
  readonly status: StagingGameDocumentV2["metadata"]["status"];
  readonly awayTeamId: string;
  readonly awayName: string;
  readonly homeTeamId: string;
  readonly homeName: string;
}

export function decodeNaverGameMetadata(bundle: RawGameBundle): NaverGameMetadata {
  const lineup = endpointPayload(bundle.payloads.lineup, "previewData", "lineup");
  const gameInfo = recordFromFirst(lineup, ["gameInfo", "game_info", "game"]);
  const gameDate = gameDateFrom(first(gameInfo, ["gdate", "gameDate"]), bundle.gameId);
  return {
    lineup,
    gameInfo,
    gameDate,
    scheduledAt: scheduledAtFrom(gameDate, first(gameInfo, ["gtime", "gameTime"])),
    status: mapStatus(
      first(gameInfo, ["statusCode", "gameStatus"]),
      hasFinalRelayEvidence(bundle.payloads.relay_summary),
    ),
    awayTeamId: requireText(first(gameInfo, ["aCode", "awayTeamCode"]), "원정팀 ID"),
    homeTeamId: requireText(first(gameInfo, ["hCode", "homeTeamCode"]), "홈팀 ID"),
    awayName: requireText(first(gameInfo, ["aName", "awayTeamName"]), "원정팀 이름"),
    homeName: requireText(first(gameInfo, ["hName", "homeTeamName"]), "홈팀 이름"),
  };
}

export function decodeNaverGameDate(bundle: RawGameBundle): string {
  const lineup = endpointPayload(bundle.payloads.lineup, "previewData", "lineup");
  const gameInfo = recordFromFirst(lineup, ["gameInfo", "game_info", "game"]);
  return gameDateFrom(first(gameInfo, ["gdate", "gameDate"]), bundle.gameId);
}

export function endpointPayload(raw: unknown, target: string, label: string): JsonRecord {
  let current = requireRecord(raw, label);
  if (current.result !== undefined) current = requireRecord(current.result, `${label}.result`);
  if (current[target] !== undefined) current = requireRecord(current[target], `${label}.${target}`);
  return current;
}

function recordFromFirst(recordValue: JsonRecord, keys: readonly string[]): JsonRecord {
  for (const key of keys) {
    if (recordValue[key] !== undefined) return requireRecord(recordValue[key], key);
  }
  throw new NaverSourceFormatError(`${keys.join("/")} 객체가 없습니다.`);
}

function mapStatus(
  raw: unknown,
  hasTerminalRelayEvidence: boolean,
): StagingGameDocumentV2["metadata"]["status"] {
  const value = optionalText(raw)?.toUpperCase();
  if (value === "CANCEL" || value === "CANCELLED") return "cancelled";
  if (value === "SUSPENDED") return "suspended";
  if (value === "BEFORE" || value === "SCHEDULED") return "scheduled";
  if (value === "LIVE" || value === "IN_PROGRESS") return "in_progress";
  if (value === "RESULT" || value === "FINAL" || value === "1") return "final";
  // Legacy numeric codes also occur on completed games. The code alone is not
  // sufficient: require the provider's explicit final footer and terminal outs.
  if ((value === "0" || value === "4") && hasTerminalRelayEvidence) return "final";
  throw new NaverSourceFormatError(`알 수 없는 경기 상태입니다: ${value ?? "없음"}`);
}

function hasFinalRelayEvidence(raw: unknown): boolean {
  if (raw === undefined) return false;
  const summary = endpointPayload(raw, "textRelayData", "relay_summary");
  const rows = optionalRecords(summary.textRelays).flatMap((block) =>
    optionalRecords(block.textOptions ?? block.events),
  );
  const terminalRows = rows.filter((row) => integer(row.type) === 99);
  const hasFooter = terminalRows.some((row) =>
    /^(?:승리투수|무승부|경기종료)\s*:?/.test(optionalText(row.text) ?? ""),
  );
  const hasThreeOutState = terminalRows.some((row) => {
    const state = record(row.currentGameState ?? row.observed_state_after);
    return integer(first(state, ["out", "outs"])) === 3;
  });
  return hasFooter && hasThreeOutState;
}

function gameDateFrom(raw: unknown, gameId: string): string {
  const value = optionalText(raw)?.replace(/-/g, "") ?? gameId.slice(0, 8);
  if (!/^\d{8}$/.test(value)) {
    throw new NaverSourceFormatError("경기 날짜 형식이 올바르지 않습니다.");
  }
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new NaverSourceFormatError("실재 달력에 있는 경기 날짜가 아닙니다.");
  }
  return date;
}

function scheduledAtFrom(gameDate: string, rawTime: unknown): string {
  const value = optionalText(rawTime) ?? "00:00";
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new NaverSourceFormatError("경기 시각 형식이 올바르지 않습니다.");
  }
  return `${gameDate}T${value}:00+09:00`;
}
