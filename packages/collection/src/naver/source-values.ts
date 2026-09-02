import { canonicalStringify, compareCanonicalStrings } from "@kbo/contracts";

import { NaverSourceFormatError } from "../errors.js";

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new NaverSourceFormatError(`${label}은 객체여야 합니다.`);
  return value;
}

export function optionalRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function requireRecords(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new NaverSourceFormatError(`${label}은 객체 배열이어야 합니다.`);
  }
  return [...value];
}

export function first(recordValue: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (recordValue[key] !== undefined) return recordValue[key];
  }
  return undefined;
}

export function optionalText(value: unknown): string | null {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    return null;
  }
  return String(value).trim();
}

export function requireText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (text === null) throw new NaverSourceFormatError(`${label}가 없습니다.`);
  return text;
}

export function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

export function validInteger(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export function meaningfulPitchId(value: unknown): string | null {
  const id = optionalText(value);
  return id === null || id === "-1" ? null : id;
}

export function parseSide(value: unknown): "away" | "home" | null {
  const text = optionalText(value)?.toLowerCase();
  return text === "away" || text === "home" ? text : null;
}

export function parseHalf(value: unknown): "top" | "bottom" | null {
  const text = optionalText(value)?.toLowerCase();
  if (text === "0" || text === "top" || text === "away") return "top";
  if (text === "1" || text === "bottom" || text === "home") return "bottom";
  return null;
}

export function sourceValueFingerprint(value: unknown): string {
  return canonicalStringify(normalizeSourceJsonValue(value));
}

function normalizeSourceJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeSourceJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, child]) => [key, normalizeSourceJsonValue(child)]),
  );
}

export function normalizedName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
