import type {
  RegistryAffiliationEffect,
  RegistryEventKind,
  RegistryRegistrationSnapshot,
  RegistryStatusEvent,
} from "@kbo/contracts";
import { load } from "cheerio";

const PLAYER_CATEGORIES = new Set(["투수", "포수", "내야수", "외야수"]);

export function parseKboRegisterHtml(
  html: string,
  snapshotDate: string,
  teamCode: string,
  teamName: string,
  sourceRequestKey: string,
): RegistryRegistrationSnapshot {
  const $ = load(html);
  const players: RegistryRegistrationSnapshot["players"] = [];
  const completeCategories = new Set<string>();
  const observedTeam = $("input[name$='hfSearchTeam']").attr("value");
  const observedDate = $("input[name$='hfSearchDate']").attr("value");
  if (observedTeam !== undefined && observedTeam !== teamCode)
    throw new Error(`KBO 등록 페이지 구단이 요청과 다릅니다: ${observedTeam}`);
  if (observedDate !== undefined && observedDate !== snapshotDate.replaceAll("-", ""))
    throw new Error(`KBO 등록 페이지 날짜가 요청과 다릅니다: ${observedDate}`);
  $("table").each((_tableIndex, table) => {
    const header = $(table).find("thead tr, tr").first();
    const category = normalizeText(header.find("th").eq(1).text());
    if (!PLAYER_CATEGORIES.has(category)) return;
    const rows = $(table).find("tbody tr");
    if (rows.length === 0) return;
    let structurallyComplete = true;
    rows.each((_rowIndex, row) => {
      const rowText = normalizeText($(row).text());
      if (/당일 1군 등록된 .*가 없습니다\.$/.test(rowText)) return;
      const cells = $(row).find("td");
      if (cells.length < 5) {
        structurallyComplete = false;
        return;
      }
      const playerLink = cells.eq(1).find("a[href*='playerId=']").first();
      const playerId = /[?&]playerId=([^&#]+)/.exec(playerLink.attr("href") ?? "")?.[1];
      const playerName = normalizeText(playerLink.text());
      if (playerId === undefined || playerName.length === 0) {
        structurallyComplete = false;
        return;
      }
      const size = parseSize(normalizeText(cells.eq(4).text()));
      players.push({
        teamCode,
        teamName,
        playerId,
        playerName,
        rosterCategory: category,
        uniformNumber: nullableText(cells.eq(0).text()),
        positionText: category,
        throwsBats: nullableText(cells.eq(2).text()),
        birthDate: parseDate(normalizeText(cells.eq(3).text())),
        heightCm: size.heightCm,
        weightKg: size.weightKg,
      });
    });
    if (structurallyComplete) completeCategories.add(category);
  });
  return {
    snapshotDate,
    teamCode,
    teamName,
    sourceRequestKey,
    complete: completeCategories.size === PLAYER_CATEGORIES.size,
    players,
  };
}

export function parseKboTradeResponse(
  value: unknown,
  sourceRequestKey: string,
  startingRowIndex: number,
): { readonly totalCount: number; readonly events: RegistryStatusEvent[] } {
  const response = record(value, "trade response");
  if (response.code !== "100") throw new Error("KBO 선수이동 응답 code가 성공이 아닙니다.");
  const rows = array(response.rows, "trade rows");
  const events = rows.map((item, index) => {
    const row = record(item, "trade row");
    const cells = array(row.row, "trade row cells").map((cell) =>
      normalizeText(string(record(cell, "trade cell").Text, "trade cell text")),
    );
    if (cells.length < 5) throw new Error("KBO 선수이동 행의 열 수가 부족합니다.");
    const [rawEffectiveDate, rawCategory, teamName, rawPlayer, rawNote] = cells;
    if (
      rawEffectiveDate === undefined ||
      rawCategory === undefined ||
      teamName === undefined ||
      rawPlayer === undefined
    ) {
      throw new Error("KBO 선수이동 필수 열이 없습니다.");
    }
    const player = /^(.*?)(?:\(([^()]*)\))?$/.exec(rawPlayer);
    const classification = classifyTradeCategory(rawCategory);
    return {
      effectiveDate: normalizeDate(rawEffectiveDate),
      rawCategory,
      eventKind: classification.eventKind,
      affiliationEffect: classification.affiliationEffect,
      teamName,
      rawPlayerName: normalizeText(player?.[1] ?? rawPlayer),
      rawPosition: nullableText(player?.[2] ?? ""),
      rawNote: nullableText(rawNote ?? ""),
      sourceRequestKey,
      sourceRowIndex: startingRowIndex + index,
    };
  });
  return { totalCount: Number(string(response.totalCnt, "trade totalCnt")), events };
}

export function classifyTradeCategory(rawCategory: string): {
  readonly eventKind: RegistryEventKind;
  readonly affiliationEffect: RegistryAffiliationEffect;
} {
  const exact: Readonly<Record<string, readonly [RegistryEventKind, RegistryAffiliationEffect]>> = {
    개명: ["name_change", "none"],
    군보류: ["military_hold", "none"],
    "군보류 자유계약선수": ["free_agent_release", "end"],
    "소속선수 추가 등록": ["affiliation_add", "start"],
    "등번호 변경": ["number_change", "none"],
    웨이버: ["waiver", "end"],
    임의해지: ["voluntary_retirement", "end"],
    "임의해지 복귀": ["voluntary_return", "start"],
    자유계약선수: ["free_agent_release", "end"],
    트레이드: ["trade", "transfer"],
    "트레이드(웨이버)": ["trade", "transfer"],
    "FA 계약": ["free_agent_contract", "start"],
    "해외 복귀 FA 계약": ["free_agent_contract", "start"],
    "FA 자격취득": ["free_agent_eligibility", "none"],
    "2차 드래프트": ["draft", "transfer"],
    "FA 보상선수": ["compensation", "transfer"],
    "부상자 명단": ["injured_list", "none"],
    경조휴가: ["leave", "none"],
    "치료·재활명단": ["rehabilitation", "none"],
    "재활선수(외국인 선수)": ["rehabilitation", "none"],
    "참가활동 정지": ["suspension", "none"],
    "자유계약선수 - 참가활동정지": ["suspension", "none"],
  };
  const result = exact[normalizeText(rawCategory)];
  return result === undefined
    ? { eventKind: "unknown", affiliationEffect: "unknown" }
    : { eventKind: result[0], affiliationEffect: result[1] };
}

function parseSize(value: string): { heightCm: number | null; weightKg: number | null } {
  const match = /^(\d{2,3})cm\s*,\s*(\d{2,3})kg$/i.exec(value);
  return match === null
    ? { heightCm: null, weightKg: null }
    : { heightCm: Number(match[1]), weightKg: Number(match[2]) };
}

function parseDate(value: string): string | null {
  try {
    return normalizeDate(value);
  } catch {
    return null;
  }
}

function normalizeDate(value: string): string {
  const normalized = value.replace(/[./]/g, "-");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))
  ) {
    throw new Error(`KBO 날짜 형식이 올바르지 않습니다: ${value}`);
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

function nullableText(value: string): string | null {
  const normalized = normalizeText(value);
  return normalized.length === 0 ? null : normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} 객체가 아닙니다.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 배열이 아닙니다.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} 문자열이 아닙니다.`);
  return value;
}
