import { createHash } from "node:crypto";

import {
  canonicalStringify,
  recordCorrectionSupportKind,
  type RecordCorrectionDecision,
  type RecordCorrectionNotice,
  type RecordCorrectionParticipant,
  type RecordCorrectionStatChange,
  type RecordCorrectionStatCode,
} from "@kbo/contracts";
import { load } from "cheerio";

const TEAM_NAMES = new Set([
  "삼성",
  "KT",
  "LG",
  "KIA",
  "두산",
  "NC",
  "롯데",
  "한화",
  "SSG",
  "키움",
  "SK",
  "넥센",
]);

export interface ParsedRecordCorrectionPage {
  readonly totalCount: number;
  readonly notices: RecordCorrectionNotice[];
}

export interface KboRecordCorrectionControlOption {
  readonly value: string;
  readonly label: string;
}

export function normalizeKboRecordCorrectionNotice(
  notice: RecordCorrectionNotice,
): RecordCorrectionNotice {
  return {
    ...notice,
    statChanges: notice.statChanges.map((stat) => {
      const mappedCode = mapStatCode(stat.rawStatName, stat.scope);
      const statCode = mappedCode === "unknown" ? stat.statCode : mappedCode;
      const classified = recordCorrectionSupportKind(stat.scope, statCode);
      const supportKind =
        mappedCode === "unknown" &&
        (stat.supportKind === "unknown" || stat.supportKind === "evidence_only")
          ? stat.supportKind
          : classified;
      return { ...stat, statCode, supportKind };
    }),
  };
}

export function parseKboRecordCorrectionControl(
  value: unknown,
): KboRecordCorrectionControlOption[] {
  const unwrapped = unwrapAsmx(value);
  const topLevelItems: unknown[] | null = Array.isArray(unwrapped) ? unwrapped : null;
  const root = topLevelItems === null ? record(unwrapped, "KBO control response") : null;
  const directItems =
    topLevelItems ?? (root === null ? null : firstArray(root, ["data", "rows", "list", "result"]));
  const nestedData =
    root !== null && directItems === null && typeof root.data === "object" && root.data !== null
      ? record(root.data, "KBO control data")
      : null;
  const rawItems =
    directItems ??
    (nestedData === null ? null : firstArray(nestedData, ["data", "rows", "list", "result"]));
  if (rawItems === null) throw new Error("KBO 기록정정 control 응답 목록이 없습니다.");
  return rawItems.map((raw, index) => {
    const item = record(raw, `KBO control item ${String(index)}`);
    const rawValue = firstString(item, ["value", "Value", "CODE", "code"]);
    const rawKey = firstString(item, ["key", "Key"]);
    const namedLabel = firstString(item, ["text", "Text", "label", "Label", "NAME", "name"]);
    const valueText = rawValue !== null && /^\d+$/.test(rawValue) ? rawValue : (rawKey ?? rawValue);
    const label =
      namedLabel ?? (rawValue !== null && rawValue !== valueText ? rawValue : (rawKey ?? rawValue));
    if (valueText === null || label === null)
      throw new Error("KBO 기록정정 control 항목 형식이 올바르지 않습니다.");
    return { value: normalizeText(valueText), label: normalizeText(label) };
  });
}

export function parseKboRecordCorrectionResponse(
  value: unknown,
  season: number,
  seriesId: number,
  seriesName: string,
  sourceRequestKey: string,
  startingRowIndex: number,
): ParsedRecordCorrectionPage {
  const unwrapped = unwrapAsmx(value);
  const root = record(unwrapped, "KBO 기록정정 응답");
  const resultCode = firstString(root, ["RESULT_CD", "resultCd", "code", "Code"]);
  if (resultCode !== null && resultCode !== "100" && resultCode !== "0")
    throw new Error(`KBO 기록정정 응답 code가 성공이 아닙니다: ${resultCode}`);
  const tableValue = root.recordTbl ?? root.table ?? root.data ?? root;
  const table = record(tableValue, "KBO 기록정정 table");
  const rows = firstArray(table, ["rows", "Rows", "list"]);
  if (rows === null) throw new Error("KBO 기록정정 응답 rows가 없습니다.");
  const totalText = firstString(table, ["totalCnt", "totalCount", "TotalCnt"]);
  const totalCount = totalText === null ? rows.length : Number(totalText);
  if (!Number.isSafeInteger(totalCount) || totalCount < 0)
    throw new Error("KBO 기록정정 totalCnt가 올바르지 않습니다.");
  return {
    totalCount,
    notices: rows.map((rawRow, index) =>
      parseNoticeRow(
        rawRow,
        season,
        seriesId,
        seriesName,
        sourceRequestKey,
        startingRowIndex + index,
      ),
    ),
  };
}

function parseNoticeRow(
  rawRow: unknown,
  season: number,
  seriesId: number,
  seriesName: string,
  sourceRequestKey: string,
  sourceRowIndex: number,
): RecordCorrectionNotice {
  const row = record(rawRow, "KBO 기록정정 행");
  const rawCells = Array.isArray(row.row) ? row.row : Array.isArray(row.cells) ? row.cells : null;
  if (rawCells === null) throw new Error("KBO 기록정정 행 cells가 없습니다.");
  const cells = rawCells.map((cell) => {
    const item = record(cell, "KBO 기록정정 cell");
    const text = firstString(item, ["Text", "text"]);
    if (text === null) throw new Error("KBO 기록정정 cell Text가 없습니다.");
    return text;
  });
  if (cells.length !== 12)
    throw new Error(`KBO 기록정정 열 수가 12가 아닙니다: ${String(cells.length)}`);

  const recordNumber = requiredPositiveInteger(plainText(cells[0] ?? ""), "기록 번호");
  const gameDate = parseMonthDay(season, plainText(cells[1] ?? ""));
  const weekdayText = plainText(cells[2] ?? "");
  const matchup = parseMatchup(htmlLines(cells[3] ?? "").join(" "));
  const venueName = requiredText(plainText(cells[4] ?? ""), "구장");
  const inningHalf = parseInningHalf(plainText(cells[5] ?? ""));
  const battingOrder = parseBattingOrder(plainText(cells[6] ?? ""));
  const rawPlayerLines = htmlLines(cells[7] ?? "");
  const beforeRecordText = plainText(cells[8] ?? "");
  const afterRecordText = plainText(cells[9] ?? "");
  const contentText = htmlLines(cells[10] ?? "").join("\n");
  const correctionDateText = requiredText(plainText(cells[11] ?? ""), "정정일");
  const playerStatGroups = parsePlayerStatGroups(contentText);
  const participants = parseParticipants(rawPlayerLines, playerStatGroups);
  const statChanges = parseStatChanges(playerStatGroups, participants);
  const stable = {
    season,
    seriesId,
    recordNumber,
    gameDate,
    weekdayText,
    matchup,
    venueName,
    inningHalf,
    battingOrder,
    beforeRecordText,
    afterRecordText,
    contentText,
    correctionDateText,
    participants,
    statChanges,
  };
  return normalizeKboRecordCorrectionNotice({
    noticeId: `${String(season)}:${String(seriesId)}:${String(recordNumber)}`,
    noticeHash: createHash("sha256").update(canonicalStringify(stable), "utf8").digest("hex"),
    sourceRequestKey,
    sourceRowIndex,
    seriesId,
    seriesName,
    recordNumber,
    gameDate,
    weekdayText,
    awayTeamName: matchup.awayTeamName,
    homeTeamName: matchup.homeTeamName,
    doubleheaderNumber: matchup.doubleheaderNumber,
    venueName,
    inning: inningHalf.inning,
    half: inningHalf.half,
    battingOrder,
    decisionBefore: parseDecision(beforeRecordText),
    decisionAfter: parseDecision(afterRecordText),
    beforeRecordText,
    afterRecordText,
    contentText,
    correctionDateText,
    participants,
    statChanges,
  });
}

interface PlayerStatGroup {
  readonly name: string;
  readonly rawTeamName: string | null;
  readonly statsText: string;
}

function parsePlayerStatGroups(contentText: string): PlayerStatGroup[] {
  const groups: PlayerStatGroup[] = [];
  let currentTeam: string | null = null;
  let pending: { name: string; rawTeamName: string | null; parts: string[] } | null = null;
  for (const line of contentText.split("\n")) {
    if (TEAM_NAMES.has(line)) {
      currentTeam = line;
      pending = null;
      continue;
    }
    const complete = /^([^(),，]+?)\s*\(([^()]+)\)\s*[,，]?$/.exec(line);
    if (complete !== null) {
      groups.push({
        name: normalizeText(complete[1] ?? ""),
        rawTeamName: currentTeam,
        statsText: complete[2] ?? "",
      });
      pending = null;
      continue;
    }
    const opening = /^([^(),，]+?)\s*\(([^()]*)$/.exec(line);
    if (opening !== null) {
      const firstPart = opening[2] ?? "";
      pending = isStatListFragment(firstPart)
        ? { name: normalizeText(opening[1] ?? ""), rawTeamName: currentTeam, parts: [firstPart] }
        : null;
      continue;
    }
    if (pending === null) continue;
    const closing = /^([^()]*)\)\s*[,，]?$/.exec(line);
    const nextPart = closing?.[1] ?? line;
    const previousPart = pending.parts.at(-1) ?? "";
    // Only join complete stat items inside an explicit open group. A new player,
    // team, missing separator or unrecognized line must not inherit that group.
    const boundary =
      previousPart.trim() === "" ||
      /[,，]\s*$/.test(previousPart) ||
      /^\s*[,，]/.test(nextPart) ||
      (closing !== null && nextPart.trim() === "");
    if (!boundary || !isStatListFragment(nextPart)) {
      pending = null;
      continue;
    }
    pending.parts.push(nextPart);
    if (closing !== null) {
      groups.push({
        name: pending.name,
        rawTeamName: pending.rawTeamName,
        statsText: pending.parts.join(" "),
      });
      pending = null;
    }
  }
  return groups;
}

function isStatListFragment(value: string): boolean {
  const text = value
    .trim()
    .replace(/^[,，]|[,，]$/g, "")
    .trim();
  return (
    text.length === 0 ||
    text.split(/[,，]/).every((item) => /^[^()]+?\s*-?\d+\s*(?:→|->)\s*-?\d+\s*$/.test(item))
  );
}

function parseParticipants(
  lines: readonly string[],
  groups: readonly PlayerStatGroup[],
): RecordCorrectionParticipant[] {
  const result: RecordCorrectionParticipant[] = [];
  for (const line of lines) {
    const parenthesized = /^\(.*\)$/.test(line);
    const playerName = normalizeText(parenthesized ? line.slice(1, -1) : line);
    if (playerName.length === 0) continue;
    result.push({
      participantIndex: result.length,
      rawTeamName: null,
      rawPlayerName: playerName,
      role: parenthesized ? "pitcher" : "unknown",
      parenthesized,
    });
  }
  for (const { name, rawTeamName, statsText } of groups) {
    if (name.length === 0) continue;
    const existing = result.find((participant) => participant.rawPlayerName === name);
    if (existing === undefined) {
      result.push({
        participantIndex: result.length,
        rawTeamName,
        rawPlayerName: name,
        role: inferRole(statsText, false),
        parenthesized: false,
      });
    } else if (existing.rawTeamName === null || existing.role === "unknown") {
      const index = existing.participantIndex;
      result[index] = {
        ...existing,
        rawTeamName: existing.rawTeamName ?? rawTeamName,
        role:
          existing.role === "unknown"
            ? inferRole(statsText, existing.parenthesized)
            : existing.role,
      };
    }
  }
  return result;
}

function parseStatChanges(
  groups: readonly PlayerStatGroup[],
  participants: readonly RecordCorrectionParticipant[],
): RecordCorrectionStatChange[] {
  const changes: RecordCorrectionStatChange[] = [];
  for (const { name, statsText } of groups) {
    const participant = participants.find((item) => item.rawPlayerName === name);
    const matcher = /([^,，]+?)\s*(-?\d+)\s*(?:→|->)\s*(-?\d+)/g;
    for (const match of statsText.matchAll(matcher)) {
      const rawStatName = normalizeText(match[1] ?? "");
      const beforeValue = Number(match[2]);
      const afterValue = Number(match[3]);
      if (
        rawStatName.length === 0 ||
        !Number.isSafeInteger(beforeValue) ||
        !Number.isSafeInteger(afterValue) ||
        beforeValue < 0 ||
        afterValue < 0
      ) {
        throw new Error(`KBO 기록정정 통계 변경 형식이 올바르지 않습니다: ${name}(${statsText})`);
      }
      const scope = participant?.role === "pitcher" ? "pitcher" : inferScope(rawStatName);
      const statCode = mapStatCode(rawStatName, scope);
      changes.push({
        statIndex: changes.length,
        participantIndex: participant?.participantIndex ?? null,
        rawStatName,
        statCode,
        scope,
        beforeValue,
        afterValue,
        supportKind: recordCorrectionSupportKind(scope, statCode),
      });
    }
  }
  return changes;
}

function mapStatCode(
  raw: string,
  scope: "batter" | "pitcher" | "fielder" | "unknown",
): RecordCorrectionStatCode {
  if (raw === "실책") return "fielding_errors";
  if (raw === "루타" || raw === "루타수") return "total_bases";
  if (scope === "pitcher") {
    const pitching: Readonly<Record<string, RecordCorrectionStatCode>> = {
      상대타자: "batters_faced",
      타수: "pitcher_at_bats",
      상대타수: "pitcher_at_bats",
      아웃: "outs_pitched",
      피안타: "hits_allowed",
      실점: "runs_allowed",
      자책: "earned_runs",
      자책점: "earned_runs",
      볼넷: "walks_allowed",
      "4구": "walks_allowed",
      고의4구: "intentional_walks_allowed",
      사구: "hit_batters",
      탈삼진: "strikeouts_pitched",
      투구: "pitches",
      투구수: "pitches",
      스트라이크: "strikes",
      희타: "pitcher_sacrifice_bunts",
      희생타: "pitcher_sacrifice_bunts",
      희생번트: "pitcher_sacrifice_bunts",
      희비: "sacrifice_flies",
      희생플라이: "sacrifice_flies",
    };
    return pitching[raw] ?? "unknown";
  }
  const batting: Readonly<Record<string, RecordCorrectionStatCode>> = {
    타석: "plate_appearances",
    타수: "at_bats",
    득점: "runs",
    안타: "hits",
    "2루타": "doubles",
    "3루타": "triples",
    홈런: "home_runs",
    타점: "runs_batted_in",
    볼넷: "walks",
    "4구": "walks",
    고의4구: "intentional_walks",
    사구: "hit_by_pitch",
    삼진: "strikeouts",
    희타: "sacrifice_bunts",
    희생타: "sacrifice_bunts",
    희생번트: "sacrifice_bunts",
    희비: "sacrifice_flies",
    희생플라이: "sacrifice_flies",
  };
  return batting[raw] ?? "unknown";
}

function inferScope(raw: string): "batter" | "pitcher" | "fielder" | "unknown" {
  if (raw.includes("실책")) return "fielder";
  if (/^(상대|피안타|실점|자책|탈삼진|투구)/.test(raw)) return "pitcher";
  return "batter";
}

function inferRole(
  statsText: string,
  parenthesized: boolean,
): "batter" | "pitcher" | "fielder" | "unknown" {
  if (parenthesized || /(상대타자|피안타|자책|탈삼진|투구수)/.test(statsText)) return "pitcher";
  if (/실책/.test(statsText)) return "fielder";
  return "batter";
}

function parseDecision(value: string): RecordCorrectionDecision {
  const normalized = value.replaceAll(" ", "");
  if (normalized.includes("야수선택")) return "fielder_choice";
  if (normalized.includes("실책")) return "error";
  if (normalized.includes("안타")) return "hit";
  return "unknown";
}

function parseMonthDay(season: number, raw: string): string {
  const full = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(raw);
  if (full !== null) {
    if (Number(full[1]) !== season)
      throw new Error(`KBO 기록정정 경기 연도가 season과 다릅니다: ${raw}`);
    return validatedDate(Number(full[1]), Number(full[2]), Number(full[3]), raw);
  }
  const match = /^(\d{1,2})[./-](\d{1,2})$/.exec(raw);
  if (match === null) throw new Error(`KBO 기록정정 경기일 형식이 올바르지 않습니다: ${raw}`);
  return validatedDate(season, Number(match[1]), Number(match[2]), raw);
}

function validatedDate(year: number, month: number, day: number, raw: string): string {
  const date = `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error(`KBO 기록정정 경기일이 올바르지 않습니다: ${raw}`);
  return date;
}

function parseMatchup(raw: string): {
  awayTeamName: string;
  homeTeamName: string;
  doubleheaderNumber: number | null;
} {
  const match = /^(.+?)\s*(?::|vs\.?|VS\.?)\s*(.+?)(?:\s*DH\s*([12]))?$/.exec(raw);
  if (match === null) throw new Error(`KBO 기록정정 대진 형식이 올바르지 않습니다: ${raw}`);
  return {
    awayTeamName: requiredText(match[1] ?? "", "원정팀"),
    homeTeamName: requiredText(match[2] ?? "", "홈팀"),
    doubleheaderNumber: match[3] === undefined ? null : Number(match[3]),
  };
}

function parseInningHalf(raw: string): { inning: number; half: "top" | "bottom" } {
  const match = /^(\d+)(?:회)?\s*(초|말)$/.exec(raw.replaceAll(" ", ""));
  if (match === null) throw new Error(`KBO 기록정정 이닝 형식이 올바르지 않습니다: ${raw}`);
  return { inning: Number(match[1]), half: match[2] === "초" ? "top" : "bottom" };
}

function parseBattingOrder(raw: string): number {
  const match = /^([1-9])(?:번(?:타자)?)?$/.exec(raw.replaceAll(" ", ""));
  if (match === null) throw new Error(`KBO 기록정정 타순 형식이 올바르지 않습니다: ${raw}`);
  return Number(match[1]);
}

function htmlLines(value: string): string[] {
  const $ = load(`<div id="root">${value}</div>`);
  $("#root br").replaceWith("\n");
  return $("#root")
    .text()
    .split(/\n+/)
    .map(normalizeText)
    .filter((line) => line.length > 0);
}

function plainText(value: string): string {
  return normalizeText(load(`<div>${value}</div>`)("div").text());
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

function requiredText(value: string, field: string): string {
  const result = normalizeText(value);
  if (result.length === 0) throw new Error(`KBO 기록정정 ${field}이(가) 비어 있습니다.`);
  return result;
}

function requiredPositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`KBO 기록정정 ${field}이(가) 올바르지 않습니다: ${value}`);
  return parsed;
}

function unwrapAsmx(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!("d" in root)) return value;
  const nested = root.d;
  if (typeof nested === "string") return JSON.parse(nested) as unknown;
  return nested;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} 객체가 아닙니다.`);
  return value as Record<string, unknown>;
}

function firstArray(root: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const key of keys) if (Array.isArray(root[key])) return root[key];
  return null;
}

function firstString(root: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return null;
}
