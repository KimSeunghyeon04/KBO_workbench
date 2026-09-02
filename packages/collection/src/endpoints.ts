import { NaverSourceFormatError } from "./errors.js";

export interface Endpoint {
  readonly name: string;
  readonly url: string;
  readonly required: boolean;
}

export class NaverEndpoints {
  public constructor(private readonly apiBase = "https://api-gw.sports.naver.com/schedule/games") {}

  public schedule(): string {
    return this.apiBase;
  }

  public relaySummary(gameId: string): Endpoint {
    assertGameId(gameId);
    return { name: "relay_summary", url: `${this.apiBase}/${gameId}/relay`, required: true };
  }

  public game(gameId: string, inningCount: number): readonly Endpoint[] {
    assertGameId(gameId);
    if (!Number.isInteger(inningCount) || inningCount < 1 || inningCount > 30) {
      throw new NaverSourceFormatError("Naver 이닝 수가 허용 범위를 벗어났습니다.");
    }
    const base = `${this.apiBase}/${gameId}`;
    return [
      { name: "lineup", url: `${base}/preview`, required: true },
      ...Array.from({ length: inningCount }, (_, index) => ({
        name: `relay_${String(index + 1).padStart(3, "0")}`,
        url: `${base}/relay?inning=${String(index + 1)}`,
        required: true,
      })),
      { name: "record", url: `${base}/record`, required: true },
    ];
  }

  public inningCount(payload: unknown): number {
    let current = asRecord(payload, "중계 요약");
    for (const key of ["result", "textRelayData"] as const) {
      const nested = current[key];
      if (nested !== undefined) current = asRecord(nested, `중계 요약.${key}`);
    }
    const score = current.inningScore;
    if (isRecord(score)) {
      const numbers = collectInningNumbers(score);
      if (numbers.length > 0) return Math.min(30, Math.max(...numbers));
    }
    for (const key of ["currentInning", "inning", "lastInning"] as const) {
      const value = toInteger(current[key]);
      if (value !== null && value >= 1) return Math.min(30, value);
    }
    throw new NaverSourceFormatError("중계 요약에서 이닝 수를 확인할 수 없습니다.");
  }
}

function assertGameId(gameId: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) {
    throw new NaverSourceFormatError("Naver gameId 형식이 올바르지 않습니다.");
  }
}

function collectInningNumbers(record: Readonly<Record<string, unknown>>): number[] {
  const result: number[] = [];
  for (const [key, value] of Object.entries(record)) {
    const match = /\d+/.exec(key);
    if (match?.[0] !== undefined) result.push(Number(match[0]));
    if (isRecord(value)) result.push(...collectInningNumbers(value));
  }
  return result;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new NaverSourceFormatError(`${label}은 객체여야 합니다.`);
  return value;
}
