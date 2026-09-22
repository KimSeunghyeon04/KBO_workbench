import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  compareCanonicalStrings,
  CollectionDiscoveryRecordSchema,
  CollectionScheduleEntriesSchema,
  CollectionSelectionRecordSchema,
  CollectionHistoryRecordSchema,
  CollectionItemResultSchema,
  type CollectionDiscoveryRecord,
  type CollectionScheduleEntry,
  type CollectionSelectionRecord,
  type CollectionHistoryRecord,
  type CollectionItemResult,
  CollectionSelectionEntrySchema,
  type CollectionSelectionEntry,
} from "@kbo/contracts";
import { atomicWrite, isMissing, readDirectoryIfPresent } from "./workspace-files.js";

const envelopeSchema = Type.Object(
  { hash: Type.String({ pattern: "^[a-f0-9]{64}$" }), payload: Type.Unknown() },
  { additionalProperties: false },
);
const rawPageSchema = Type.Object(
  { status: Type.Integer(), url: Type.String(), payload: Type.Unknown() },
  { additionalProperties: false },
);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Collection evidence and operation records share the owning workspace writer lock. */
export class CollectionWorkspace {
  private readonly resultCache = new Map<string, { rows: CollectionItemResult[]; bytes: number }>();
  private readonly resultReads = new Map<string, Promise<CollectionItemResult[]>>();
  private readonly resultVersions = new Map<string, number>();
  private resultBytes = 0;
  private resultVersion = 0;
  private historyVersion = 0;
  private historyCache: CollectionHistoryRecord[] | undefined;
  private historyRead: Promise<CollectionHistoryRecord[]> | undefined;
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}

  public saveDiscovery(record: CollectionDiscoveryRecord): Promise<void> {
    return this.write(
      this.file("discoveries", record.discovery.discoveryId, "record.json"),
      CollectionDiscoveryRecordSchema,
      record,
    );
  }
  public discovery(id: string): Promise<CollectionDiscoveryRecord | null> {
    return this.read(this.file("discoveries", id, "record.json"), CollectionDiscoveryRecordSchema);
  }
  public async discoveries(): Promise<CollectionDiscoveryRecord[]> {
    return this.records("discoveries", (id) => this.discovery(id));
  }
  public saveEntries(id: string, entries: readonly CollectionScheduleEntry[]): Promise<void> {
    return this.write(
      this.file("discoveries", id, "entries.json"),
      CollectionScheduleEntriesSchema,
      entries,
    );
  }
  public async entries(id: string): Promise<CollectionScheduleEntry[]> {
    return (
      (await this.read(
        this.file("discoveries", id, "entries.json"),
        CollectionScheduleEntriesSchema,
      )) ?? []
    );
  }
  public async savePage(
    id: string,
    page: number,
    value: Static<typeof rawPageSchema>,
  ): Promise<void> {
    await this.assertWriter();
    const payload = Value.Decode(rawPageSchema, value);
    const encoded = canonicalStringify({ hash: hash(payload), payload });
    const filename = this.file("discoveries", id, `page-${String(page)}.json.gz`);
    if ((await this.readBytes(filename)) !== null)
      throw new Error("일정 원문 page는 덮어쓸 수 없습니다.");
    await atomicWrite(filename, await gzipAsync(encoded));
  }
  public async page(id: string, page: number): Promise<Static<typeof rawPageSchema> | null> {
    const bytes = await this.readBytes(
      this.file("discoveries", id, `page-${String(page)}.json.gz`),
    );
    return bytes === null
      ? null
      : decode(rawPageSchema, (await gunzipAsync(bytes)).toString("utf8"));
  }
  public saveSelection(record: CollectionSelectionRecord): Promise<void> {
    return this.write(
      this.file("selections", record.selection.selectionId, "record.json"),
      CollectionSelectionRecordSchema,
      record,
      true,
    );
  }
  public selection(id: string): Promise<CollectionSelectionRecord | null> {
    return this.read(this.file("selections", id, "record.json"), CollectionSelectionRecordSchema);
  }
  public async saveHistory(record: CollectionHistoryRecord): Promise<void> {
    const saved = Value.Decode(CollectionHistoryRecordSchema, structuredClone(record));
    const previous = this.historyCache;
    const version = ++this.historyVersion;
    this.historyCache = undefined;
    this.historyRead = undefined;
    let written = false;
    try {
      await this.write(
        this.file("jobs", saved.job.jobId, "record.json"),
        CollectionHistoryRecordSchema,
        saved,
      );
      written = true;
    } finally {
      const unchanged = this.historyVersion === version;
      this.historyVersion += 1;
      this.historyCache = undefined;
      this.historyRead = undefined;
      if (written && unchanged && previous !== undefined) {
        const next = previous.filter((item) => item.job.jobId !== saved.job.jobId);
        next.push(saved);
        this.cacheHistories(next);
      }
    }
  }
  public saveTargets(jobId: string, entries: readonly CollectionSelectionEntry[]): Promise<void> {
    return this.write(
      this.file("jobs", jobId, "targets.json"),
      Type.Array(CollectionSelectionEntrySchema, { maxItems: 50_000 }),
      entries,
      true,
    );
  }
  public async targets(jobId: string): Promise<CollectionSelectionEntry[]> {
    return (
      (await this.read(
        this.file("jobs", jobId, "targets.json"),
        Type.Array(CollectionSelectionEntrySchema, { maxItems: 50_000 }),
      )) ?? []
    );
  }
  public history(id: string): Promise<CollectionHistoryRecord | null> {
    return this.read(this.file("jobs", id, "record.json"), CollectionHistoryRecordSchema);
  }
  public async histories(): Promise<CollectionHistoryRecord[]> {
    return structuredClone(await this.orderedHistories());
  }
  public async historyPage(
    offset: number,
    limit: number,
  ): Promise<{ records: CollectionHistoryRecord[]; total: number }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("Invalid history page");
    const records = await this.orderedHistories();
    return {
      records: structuredClone(records.slice(offset, offset + limit)),
      total: records.length,
    };
  }
  private orderedHistories(): Promise<CollectionHistoryRecord[]> {
    if (this.historyCache !== undefined) return Promise.resolve(this.historyCache);
    if (this.historyRead !== undefined) return this.historyRead;
    const version = this.historyVersion;
    const read = this.records("jobs", (id) => this.history(id))
      .then((records) => {
        if (this.historyVersion !== version) return this.orderedHistories();
        this.cacheHistories(records);
        return records;
      })
      .finally(() => {
        if (this.historyRead === read) this.historyRead = undefined;
      });
    this.historyRead = read;
    return read;
  }
  private cacheHistories(records: CollectionHistoryRecord[]): void {
    records.sort(
      (a, b) =>
        compareCanonicalStrings(b.job.createdAt, a.job.createdAt) ||
        compareCanonicalStrings(a.job.jobId, b.job.jobId),
    );
    if (
      records.length <= 20_000 &&
      Buffer.byteLength(JSON.stringify(records), "utf8") <= 32 * 1024 * 1024
    )
      this.historyCache = records;
  }
  public async saveResult(jobId: string, result: CollectionItemResult): Promise<void> {
    const previous = this.resultCache.get(jobId);
    const version = this.invalidateResults(jobId);
    let written = false;
    try {
      await this.write(
        this.file("jobs", jobId, `items/${safeId(result.gameId)}.json`),
        CollectionItemResultSchema,
        result,
        true,
      );
      written = true;
      await this.rememberResult(result);
    } finally {
      const unchanged = this.resultVersions.get(jobId) === version;
      this.invalidateResults(jobId);
      if (written && unchanged && previous !== undefined) {
        this.cacheResults(jobId, [
          ...previous.rows.filter((row) => row.gameId !== result.gameId),
          structuredClone(result),
        ]);
      }
    }
  }
  public async rememberResult(result: CollectionItemResult): Promise<void> {
    if (result.gameDate === null) return;
    const filename = this.file("known-games", result.gameId, "record.json");
    const previous = await this.read(filename, CollectionItemResultSchema);
    if (previous !== null && previous.finishedAt >= result.finishedAt) return;
    await this.write(filename, CollectionItemResultSchema, result);
  }
  public knownGames(gameIds: readonly string[]): Promise<CollectionItemResult[]> {
    return compactBatches(gameIds, (id) =>
      this.read(this.file("known-games", id, "record.json"), CollectionItemResultSchema),
    );
  }
  public async results(jobId: string): Promise<CollectionItemResult[]> {
    safeId(jobId);
    const cached = this.resultCache.get(jobId);
    if (cached !== undefined) {
      this.resultCache.delete(jobId);
      this.resultCache.set(jobId, cached);
      return structuredClone(cached.rows);
    }
    const version = this.resultVersions.get(jobId);
    let pending = this.resultReads.get(jobId);
    if (pending === undefined) {
      pending = this.readResults(jobId)
        .then((rows) => {
          if (this.resultVersions.get(jobId) === version) this.cacheResults(jobId, rows);
          return rows;
        })
        .finally(() => {
          if (this.resultReads.get(jobId) === pending) this.resultReads.delete(jobId);
        });
      this.resultReads.set(jobId, pending);
    }
    try {
      const rows = await pending;
      return this.resultVersions.get(jobId) === version
        ? structuredClone(rows)
        : this.results(jobId);
    } catch (error: unknown) {
      if (this.resultVersions.get(jobId) !== version) return this.results(jobId);
      throw error;
    }
  }
  private async readResults(jobId: string): Promise<CollectionItemResult[]> {
    const directory = this.file("jobs", jobId, "items");
    const files = (await readDirectoryIfPresent(directory)).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json"),
    );
    return compactBatches(
      files.map((entry) => path.join(directory, entry.name)).sort(compareCanonicalStrings),
      (filename) => this.read(filename, CollectionItemResultSchema),
    );
  }
  private invalidateResults(jobId: string): number {
    this.resultVersion += 1;
    this.resultVersions.set(jobId, this.resultVersion);
    const cached = this.resultCache.get(jobId);
    if (cached !== undefined) this.resultBytes -= cached.bytes;
    this.resultCache.delete(jobId);
    this.resultReads.delete(jobId);
    return this.resultVersion;
  }
  private cacheResults(jobId: string, rows: CollectionItemResult[]): void {
    rows.sort((a, b) => compareCanonicalStrings(a.gameId, b.gameId));
    const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    if (bytes > 32 * 1024 * 1024) return;
    const previous = this.resultCache.get(jobId);
    if (previous !== undefined) this.resultBytes -= previous.bytes;
    this.resultCache.delete(jobId);
    this.resultCache.set(jobId, { rows, bytes });
    this.resultBytes += bytes;
    while (this.resultCache.size > 16 || this.resultBytes > 32 * 1024 * 1024) {
      const oldest = this.resultCache.keys().next().value;
      if (oldest === undefined) break;
      const cached = this.resultCache.get(oldest);
      if (cached !== undefined) this.resultBytes -= cached.bytes;
      this.resultCache.delete(oldest);
    }
  }
  private async records<T>(kind: string, read: (id: string) => Promise<T | null>): Promise<T[]> {
    const dirs = (await readDirectoryIfPresent(path.join(this.root, "collection", kind)))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCanonicalStrings);
    return compactBatches(dirs, read);
  }
  private file(kind: string, id: string, filename: string): string {
    return path.join(this.root, "collection", kind, safeId(id), filename);
  }
  private async readBytes(filename: string): Promise<Buffer | null> {
    try {
      return await readFile(filename);
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  private async read<S extends TSchema>(filename: string, schema: S): Promise<Static<S> | null> {
    const bytes = await this.readBytes(filename);
    return bytes === null ? null : decode(schema, bytes.toString("utf8"));
  }
  private async write<S extends TSchema>(
    filename: string,
    schema: S,
    value: unknown,
    immutable = false,
  ): Promise<void> {
    await this.assertWriter();
    const payload = Value.Decode(schema, value);
    const encoded = `${canonicalStringify({ hash: hash(payload), payload })}\n`;
    if (immutable) {
      const previous = await this.readBytes(filename);
      if (previous !== null) {
        if (previous.toString("utf8") === encoded) return;
        throw new Error("확정된 수집 대상 또는 경기 결과는 덮어쓸 수 없습니다.");
      }
    }
    await atomicWrite(filename, encoded);
  }
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}
function decode<S extends TSchema>(schema: S, text: string): Static<S> {
  const envelope = Value.Decode(envelopeSchema, JSON.parse(text) as unknown);
  if (hash(envelope.payload) !== envelope.hash)
    throw new Error("수집 기록 hash가 일치하지 않습니다.");
  return Value.Decode(schema, envelope.payload);
}
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("유효하지 않은 수집 기록 ID입니다.");
  return id;
}
async function compactBatches<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T | null>,
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 16) {
    for (const record of await Promise.all(ids.slice(offset, offset + 16).map(read)))
      if (record !== null) result.push(record);
  }
  return result;
}
