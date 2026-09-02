import { createHash } from "node:crypto";

import {
  canonicalStringify,
  compareCanonicalStrings,
  parseRegistrySeasonDataset,
  type RegistrySeasonDataset,
  type RegistrySourcePage,
  type RegistryStatusEvent,
} from "@kbo/contracts";

import { KboRegistryHttpClient } from "./client.js";
import { parseKboRegisterHtml, parseKboTradeResponse } from "./parser.js";

export const KBO_REGISTRY_TEAMS = [
  { code: "SS", name: "삼성" },
  { code: "KT", name: "KT" },
  { code: "LG", name: "LG" },
  { code: "HT", name: "KIA" },
  { code: "OB", name: "두산" },
  { code: "NC", name: "NC" },
  { code: "LT", name: "롯데" },
  { code: "HH", name: "한화" },
  { code: "SK", name: "SSG" },
  { code: "WO", name: "키움" },
] as const;

export interface RegistryPageArtifact {
  readonly artifactKey: string;
  readonly contentHash: string;
}

export interface RegistryPageSinkInput {
  readonly pageKind: "register" | "trade";
  readonly requestKey: string;
  readonly body: string;
  readonly collectedAt: string;
}

export type RegistryPageSink = (input: RegistryPageSinkInput) => Promise<RegistryPageArtifact>;
export type RegistryPageCache = (
  pageKind: "register" | "trade",
  requestKey: string,
) => Promise<
  (RegistryPageArtifact & { readonly body: string; readonly collectedAt: string }) | null
>;

export interface KboRegistryCollectionOptions {
  readonly season: number;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly sink: RegistryPageSink;
  readonly cache?: RegistryPageCache;
}

export interface KboRegistryCollectionResult {
  readonly dataset: RegistrySeasonDataset;
  readonly sourceBundleHash: string;
}

export class KboRegistryCollector {
  public constructor(private readonly client: KboRegistryHttpClient) {}

  public async collect(
    options: KboRegistryCollectionOptions,
  ): Promise<KboRegistryCollectionResult> {
    validateRange(options.season, options.dateFrom, options.dateTo);
    const sourcePages: RegistrySourcePage[] = [];
    const snapshots: RegistrySeasonDataset["registrationSnapshots"] = [];
    const jobs = datesBetween(options.dateFrom, options.dateTo).flatMap((date) =>
      KBO_REGISTRY_TEAMS.map((team) => ({ date, team })),
    );
    await boundedMap(jobs, options.concurrency ?? 2, async ({ date, team }) => {
      const requestKey = `register:${date}:${team.code}`;
      const cached = await options.cache?.("register", requestKey);
      const page = cached ?? (await this.client.registerPage(date, team.code, options.signal));
      const artifact =
        cached ??
        (await options.sink({
          pageKind: "register",
          requestKey,
          body: page.body,
          collectedAt: page.collectedAt,
        }));
      const snapshot = parseKboRegisterHtml(page.body, date, team.code, team.name, requestKey);
      if (!snapshot.complete) throw new Error(`KBO 등록 페이지가 비어 있습니다: ${requestKey}`);
      sourcePages.push({
        pageKind: "register",
        requestKey,
        artifactKey: artifact.artifactKey,
        contentHash: artifact.contentHash,
        collectedAt: page.collectedAt,
      });
      snapshots.push(snapshot);
    });

    const statusEvents: RegistryStatusEvent[] = [];
    for (const month of monthsBetween(options.dateFrom, options.dateTo)) {
      let pageNumber = 1;
      let collected = 0;
      let total = Number.POSITIVE_INFINITY;
      while (collected < total) {
        const requestKey = `trade:${String(options.season)}:${String(month).padStart(2, "0")}:${String(pageNumber)}`;
        const cached = await options.cache?.("trade", requestKey);
        const page =
          cached ??
          (await this.client.tradePage(options.season, month, pageNumber, 100, options.signal));
        const artifact =
          cached ??
          (await options.sink({
            pageKind: "trade",
            requestKey,
            body: page.body,
            collectedAt: page.collectedAt,
          }));
        const parsed = parseKboTradeResponse(
          JSON.parse(page.body) as unknown,
          requestKey,
          collected,
        );
        sourcePages.push({
          pageKind: "trade",
          requestKey,
          artifactKey: artifact.artifactKey,
          contentHash: artifact.contentHash,
          collectedAt: page.collectedAt,
        });
        statusEvents.push(
          ...parsed.events.filter(
            (event) =>
              event.effectiveDate >= options.dateFrom && event.effectiveDate <= options.dateTo,
          ),
        );
        total = parsed.totalCount;
        collected += parsed.events.length;
        if (parsed.events.length === 0) break;
        pageNumber += 1;
      }
    }

    const dataset = parseRegistrySeasonDataset({
      season: options.season,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      sourcePages: sourcePages.sort(sourcePageOrder),
      registrationSnapshots: snapshots.sort(
        (left, right) =>
          compareCanonicalStrings(left.snapshotDate, right.snapshotDate) ||
          compareCanonicalStrings(left.teamCode, right.teamCode),
      ),
      statusEvents: statusEvents.sort(
        (left, right) =>
          compareCanonicalStrings(left.effectiveDate, right.effectiveDate) ||
          compareCanonicalStrings(left.sourceRequestKey, right.sourceRequestKey) ||
          left.sourceRowIndex - right.sourceRowIndex,
      ),
    });
    return {
      dataset,
      sourceBundleHash: createHash("sha256")
        .update(
          canonicalStringify(
            dataset.sourcePages.map((page) => ({
              pageKind: page.pageKind,
              requestKey: page.requestKey,
              contentHash: page.contentHash,
            })),
          ),
          "utf8",
        )
        .digest("hex"),
    };
  }
}

export function registryContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function sourcePageOrder(left: RegistrySourcePage, right: RegistrySourcePage): number {
  return compareCanonicalStrings(left.requestKey, right.requestKey);
}

function datesBetween(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function monthsBetween(from: string, to: string): number[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const result: number[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    if (cursor.getUTCFullYear() === start.getUTCFullYear()) result.push(cursor.getUTCMonth() + 1);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...new Set(result)];
}

function validateRange(season: number, from: string, to: string): void {
  if (!Number.isInteger(season) || season < 2017 || season > 9999)
    throw new Error("KBO registry season이 올바르지 않습니다.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
    throw new Error("KBO registry 날짜 범위가 올바르지 않습니다.");
  if (!from.startsWith(`${String(season)}-`) || !to.startsWith(`${String(season)}-`))
    throw new Error("KBO registry 날짜 범위는 한 시즌 안에 있어야 합니다.");
}

async function boundedMap<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10)
    throw new Error("KBO registry concurrency는 1~10이어야 합니다.");
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) await operation(value);
      }
    }),
  );
}
