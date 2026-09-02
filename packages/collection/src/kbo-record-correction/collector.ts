import { createHash } from "node:crypto";

import {
  canonicalStringify,
  compareCanonicalStrings,
  parseRecordCorrectionSeasonDataset,
  type RecordCorrectionNotice,
  type RecordCorrectionSeasonDataset,
  type RecordCorrectionSourcePage,
} from "@kbo/contracts";

import { KboRecordCorrectionHttpClient } from "./client.js";
import { parseKboRecordCorrectionControl, parseKboRecordCorrectionResponse } from "./parser.js";

export interface RecordCorrectionPageArtifact {
  readonly artifactKey: string;
  readonly contentHash: string;
}

export interface RecordCorrectionCachedPage extends RecordCorrectionPageArtifact {
  readonly body: string;
  readonly collectedAt: string;
}

export interface RecordCorrectionPageSinkInput {
  readonly pageKind: "landing" | "control" | "records";
  readonly requestKey: string;
  readonly seriesId: number | null;
  readonly pageNumber: number | null;
  readonly body: string;
  readonly collectedAt: string;
  readonly rowCount: number;
  readonly totalCount: number | null;
}

export type RecordCorrectionPageSink = (
  input: RecordCorrectionPageSinkInput,
) => Promise<RecordCorrectionPageArtifact>;

export type RecordCorrectionPageCache = (
  pageKind: RecordCorrectionPageSinkInput["pageKind"],
  requestKey: string,
) => Promise<RecordCorrectionCachedPage | null>;

export interface KboRecordCorrectionCollectionOptions {
  readonly season: number;
  readonly signal?: AbortSignal;
  readonly sink: RecordCorrectionPageSink;
  readonly cache?: RecordCorrectionPageCache;
}

export interface KboRecordCorrectionCollectionResult {
  readonly dataset: RecordCorrectionSeasonDataset;
  readonly sourceBundleHash: string;
}

export class KboRecordCorrectionCollector {
  public constructor(
    private readonly client: Pick<
      KboRecordCorrectionHttpClient,
      "landing" | "records" | "series" | "years"
    >,
  ) {}

  public async collect(
    options: KboRecordCorrectionCollectionOptions,
  ): Promise<KboRecordCorrectionCollectionResult> {
    if (!Number.isInteger(options.season) || options.season < 1982 || options.season > 9999)
      throw new Error("KBO 기록정정 season이 올바르지 않습니다.");
    const sourcePages: RecordCorrectionSourcePage[] = [];
    const landingKey = `landing:${String(options.season)}`;
    const landing = await readOrFetchPage(options, "landing", landingKey, () =>
      this.client.landing(options.signal),
    );
    sourcePages.push(
      await storePage(options, landing, {
        pageKind: "landing",
        requestKey: landingKey,
        seriesId: null,
        pageNumber: null,
        body: landing.body,
        collectedAt: landing.collectedAt,
        rowCount: 0,
        totalCount: null,
      }),
    );

    const yearsKey = `control:years:${String(options.season)}`;
    const years = await readOrFetchPage(options, "control", yearsKey, () =>
      this.client.years(options.signal),
    );
    const yearOptions = parseKboRecordCorrectionControl(JSON.parse(years.body) as unknown);
    if (!yearOptions.some((item) => Number(item.value) === options.season))
      throw new Error(`KBO 기록정정 control에 ${String(options.season)} 시즌이 없습니다.`);
    sourcePages.push(
      await storePage(options, years, {
        pageKind: "control",
        requestKey: yearsKey,
        seriesId: null,
        pageNumber: null,
        body: years.body,
        collectedAt: years.collectedAt,
        rowCount: yearOptions.length,
        totalCount: yearOptions.length,
      }),
    );

    const seriesKey = `control:series:${String(options.season)}`;
    const seriesPage = await readOrFetchPage(options, "control", seriesKey, () =>
      this.client.series(options.season, options.signal),
    );
    const parsedSeries = parseKboRecordCorrectionControl(JSON.parse(seriesPage.body) as unknown);
    if (parsedSeries.length === 0)
      throw new Error(`KBO 기록정정 control에 ${String(options.season)} 시즌 시리즈가 없습니다.`);
    const seriesOptions = parsedSeries;
    sourcePages.push(
      await storePage(options, seriesPage, {
        pageKind: "control",
        requestKey: seriesKey,
        seriesId: null,
        pageNumber: null,
        body: seriesPage.body,
        collectedAt: seriesPage.collectedAt,
        rowCount: seriesOptions.length,
        totalCount: seriesOptions.length,
      }),
    );

    const notices: RecordCorrectionNotice[] = [];
    for (const series of seriesOptions) {
      const seriesId = Number(series.value);
      if (!Number.isSafeInteger(seriesId) || seriesId < 0)
        throw new Error(`KBO 기록정정 series ID가 올바르지 않습니다: ${series.value}`);
      let pageNumber = 1;
      let collected = 0;
      let total = Number.POSITIVE_INFINITY;
      while (collected < total) {
        const requestKey = `records:${String(options.season)}:${String(seriesId)}:${String(pageNumber)}`;
        const page = await readOrFetchPage(options, "records", requestKey, () =>
          this.client.records(options.season, seriesId, pageNumber, options.signal),
        );
        const parsed = parseKboRecordCorrectionResponse(
          JSON.parse(page.body) as unknown,
          options.season,
          seriesId,
          series.label,
          requestKey,
          collected,
        );
        sourcePages.push(
          await storePage(options, page, {
            pageKind: "records",
            requestKey,
            seriesId,
            pageNumber,
            body: page.body,
            collectedAt: page.collectedAt,
            rowCount: parsed.notices.length,
            totalCount: parsed.totalCount,
          }),
        );
        notices.push(...parsed.notices);
        total = parsed.totalCount;
        collected += parsed.notices.length;
        if (parsed.notices.length === 0) break;
        pageNumber += 1;
      }
    }

    const dataset = parseRecordCorrectionSeasonDataset({
      season: options.season,
      collectedAt: latestCollectedAt(sourcePages),
      sourcePages: sourcePages.sort((left, right) =>
        compareCanonicalStrings(left.requestKey, right.requestKey),
      ),
      notices: notices.sort(
        (left, right) =>
          left.seriesId - right.seriesId ||
          left.recordNumber - right.recordNumber ||
          compareCanonicalStrings(left.noticeId, right.noticeId),
      ),
    });
    const sourceBundleHash = createHash("sha256")
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
      .digest("hex");
    return { dataset, sourceBundleHash };
  }
}

async function storePage(
  options: KboRecordCorrectionCollectionOptions,
  page: RecordCorrectionCachedPage,
  input: RecordCorrectionPageSinkInput,
): Promise<RecordCorrectionSourcePage> {
  const artifact = page.artifactKey.length === 0 ? await options.sink(input) : page;
  return {
    pageKind: input.pageKind,
    requestKey: input.requestKey,
    seriesId: input.seriesId,
    pageNumber: input.pageNumber,
    artifactKey: artifact.artifactKey,
    contentHash: artifact.contentHash,
    collectedAt: input.collectedAt,
    rowCount: input.rowCount,
    totalCount: input.totalCount,
  };
}

async function readOrFetchPage(
  options: KboRecordCorrectionCollectionOptions,
  pageKind: RecordCorrectionPageSinkInput["pageKind"],
  requestKey: string,
  fetchPage: () => Promise<{ readonly body: string; readonly collectedAt: string }>,
): Promise<RecordCorrectionCachedPage> {
  const cached = await options.cache?.(pageKind, requestKey);
  if (cached !== undefined && cached !== null) return cached;
  const page = await fetchPage();
  return { ...page, artifactKey: "", contentHash: "" };
}

function latestCollectedAt(pages: readonly RecordCorrectionSourcePage[]): string {
  const latest = pages
    .map((page) => page.collectedAt)
    .sort()
    .at(-1);
  if (latest === undefined) throw new Error("KBO 기록정정 source page가 없습니다.");
  return latest;
}

export function recordCorrectionContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
