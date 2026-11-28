import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
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
  type CollectionDateRange,
  type CollectionScheduleEntry,
  type CollectionSelectionRecord,
  type CollectionHistoryRecord,
  type CollectionItemResult,
  CollectionSelectionEntrySchema,
  type CollectionSelectionEntry,
} from "@kbo/contracts";
import { atomicWrite, isMissing, readDirectoryIfPresent } from "./workspace-files.js";
import { jsonFileVersion } from "./verified-json-files.js";

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

const resultIndexRowSchema = Type.Object(
  {
    ...Type.Pick(CollectionItemResultSchema, ["gameId", "finishedAt", "outcome"]).properties,
    hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    version: Type.String({ pattern: "^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+$" }),
  },
  { additionalProperties: false },
);
const resultIndexSchema = Type.Array(resultIndexRowSchema);
type ResultIndexRow = Static<typeof resultIndexRowSchema>;

function compareHistoryResults(
  a: Pick<CollectionItemResult, "gameId" | "finishedAt">,
  b: Pick<CollectionItemResult, "gameId" | "finishedAt">,
): number {
  return (
    compareCanonicalStrings(a.finishedAt, b.finishedAt) ||
    compareCanonicalStrings(a.gameId, b.gameId)
  );
}

function problemResult({ outcome }: Pick<CollectionItemResult, "outcome">): boolean {
  return outcome === "quarantined" || outcome === "source_failure" || outcome === "interrupted";
}

function resultHistoryIsFinal(status: CollectionHistoryRecord["job"]["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

class CachedResults {
  private readonly byGame = new Map<
    string,
    { row: CollectionItemResult; bytes: number; version: string | undefined }
  >();
  private history: CollectionItemResult[] | undefined;
  private problems: CollectionItemResult[] | undefined;
  private gameOrder: CollectionItemResult[] | undefined;
  public bytes = 2;

  public constructor(items: readonly VerifiedResultFile[]) {
    for (const { row, version } of items) this.add(row, version);
  }

  public add(row: CollectionItemResult, version: string | undefined): void {
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    const previous = this.byGame.get(row.gameId);
    this.bytes += bytes - (previous?.bytes ?? 0);
    if (previous === undefined && this.byGame.size > 0) this.bytes += 1;
    this.byGame.set(row.gameId, { row, bytes, version });
    this.gameOrder = undefined;
    this.history = undefined;
    this.problems = undefined;
  }

  public byGameId(): CollectionItemResult[] {
    return (this.gameOrder ??= [...this.byGame.values()]
      .map(({ row }) => row)
      .sort((a, b) => compareCanonicalStrings(a.gameId, b.gameId)));
  }

  public ordered(problemsOnly = false): CollectionItemResult[] {
    const all = (this.history ??= [...this.byGameId()].sort(compareHistoryResults));
    return problemsOnly ? (this.problems ??= all.filter(problemResult)) : all;
  }

  public index(): ResultIndexRow[] | null {
    const records: ResultIndexRow[] = [];
    for (const { gameId, finishedAt, outcome, ...fields } of this.ordered()) {
      const version = this.byGame.get(gameId)?.version;
      if (version === undefined) return null;
      records.push({
        gameId,
        finishedAt,
        outcome,
        version,
        hash: hash({ gameId, finishedAt, outcome, ...fields }),
      });
    }
    return records;
  }
}

interface VerifiedResultFile {
  name: string;
  row: CollectionItemResult;
  version: string | undefined;
}
function discoveryRangeKey(range: CollectionDateRange): string {
  return `${range.startDate}:${range.endDate}`;
}

class DiscoveryIndex {
  private readonly byId = new Map<string, CollectionDiscoveryRecord>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly byRange = new Map<string, Set<string>>();

  public replace(record: CollectionDiscoveryRecord): void {
    const id = record.discovery.discoveryId;
    const previous = this.byId.get(id);
    const keys = [
      { index: this.byKey, key: (row: CollectionDiscoveryRecord) => row.idempotencyKey },
      {
        index: this.byRange,
        key: (row: CollectionDiscoveryRecord) => discoveryRangeKey(row.discovery.range),
      },
    ];
    for (const { index, key } of keys) {
      const nextKey = key(record);
      if (previous !== undefined) {
        const previousKey = key(previous);
        if (previousKey !== nextKey) {
          const ids = index.get(previousKey);
          ids?.delete(id);
          if (ids?.size === 0) index.delete(previousKey);
        }
      }
      const ids = index.get(nextKey) ?? new Set<string>();
      ids.add(id);
      index.set(nextKey, ids);
    }
    this.byId.set(id, record);
  }

  public list(): CollectionDiscoveryRecord[] {
    return structuredClone([...this.byId.values()].sort(compareDiscoveryIds));
  }

  public forRange(range: CollectionDateRange): CollectionDiscoveryRecord["discovery"][] {
    const records = this.records(this.byRange.get(discoveryRangeKey(range)));
    records.sort(
      (left, right) =>
        compareCanonicalStrings(right.discovery.createdAt, left.discovery.createdAt) ||
        compareDiscoveryIds(left, right),
    );
    return records.slice(0, 50).map(({ discovery }) => structuredClone(discovery));
  }

  public forKey(key: string): CollectionDiscoveryRecord | undefined {
    const first = this.records(this.byKey.get(key)).sort(compareDiscoveryIds)[0];
    return first === undefined ? undefined : structuredClone(first);
  }

  private records(ids: ReadonlySet<string> | undefined): CollectionDiscoveryRecord[] {
    const result: CollectionDiscoveryRecord[] = [];
    for (const id of ids ?? []) {
      const record = this.byId.get(id);
      if (record !== undefined) result.push(record);
    }
    return result;
  }
}

function compareDiscoveryIds(left: CollectionDiscoveryRecord, right: CollectionDiscoveryRecord) {
  return compareCanonicalStrings(left.discovery.discoveryId, right.discovery.discoveryId);
}

/** Collection evidence and operation records share the owning workspace writer lock. */
export class CollectionWorkspace {
  private discoveryOperations: Promise<unknown> = Promise.resolve();
  private discoveryIndex: DiscoveryIndex | undefined;
  private readonly resultCache = new Map<string, CachedResults>();
  private readonly resultReads = new Map<string, Promise<CollectionItemResult[]>>();
  private readonly resultIndexWrites = new Map<
    string,
    { version: number | undefined; promise: Promise<void> }
  >();
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

  public async saveDiscovery(record: CollectionDiscoveryRecord): Promise<void> {
    // Publish exactly the normalized record that readers of the verified file will see.
    const saved = Value.Decode(
      CollectionDiscoveryRecordSchema,
      JSON.parse(canonicalStringify(record)),
    );
    const file = this.file("discoveries", saved.discovery.discoveryId, "record.json");
    const execution = this.discoveryOperations.then(async () => {
      try {
        await this.write(file, CollectionDiscoveryRecordSchema, saved);
        this.discoveryIndex?.replace(saved);
      } catch (error) {
        // The rename can succeed before a directory sync fails.
        this.discoveryIndex = undefined;
        throw error;
      }
    });
    this.discoveryOperations = execution.catch(() => undefined);
    return execution;
  }
  public discovery(id: string): Promise<CollectionDiscoveryRecord | null> {
    return this.read(this.file("discoveries", id, "record.json"), CollectionDiscoveryRecordSchema);
  }
  public async discoveries(): Promise<CollectionDiscoveryRecord[]> {
    return (await this.readDiscoveryIndex()).list();
  }
  public async discoveriesForRange(range: CollectionDateRange) {
    return (await this.readDiscoveryIndex()).forRange(range);
  }
  public async discoveryForKey(key: string) {
    return (await this.readDiscoveryIndex()).forKey(key);
  }
  private async readDiscoveryIndex(): Promise<DiscoveryIndex> {
    if (this.discoveryIndex !== undefined) return this.discoveryIndex;
    const execution = this.discoveryOperations.then(async () => {
      if (this.discoveryIndex !== undefined) return this.discoveryIndex;
      const index = new DiscoveryIndex();
      for (const record of await this.records("discoveries", (id) => this.discovery(id)))
        index.replace(record);
      this.discoveryIndex = index;
      return index;
    });
    this.discoveryOperations = execution.catch(() => undefined);
    return execution;
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
    await atomicWrite(this.root, filename, await gzipAsync(encoded));
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
    const results = this.resultCache.get(saved.job.jobId);
    if (results !== undefined && resultHistoryIsFinal(saved.job.status))
      await this.writeResultIndex(
        saved.job.jobId,
        results,
        this.resultVersions.get(saved.job.jobId),
      );
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
    const saved = Value.Decode(CollectionItemResultSchema, JSON.parse(canonicalStringify(result)));
    const previous = this.resultCache.get(jobId);
    const version = this.invalidateResults(jobId);
    const name = `${safeId(saved.gameId)}.json`;
    const filename = this.file("jobs", jobId, `items/${name}`);
    let writtenVersion: string | undefined;
    let written = false;
    try {
      await this.write(filename, CollectionItemResultSchema, saved, true);
      written = true;
      writtenVersion = await stat(filename, { bigint: true }).then(
        jsonFileVersion,
        () => undefined,
      );
      await this.rememberResult(saved);
    } finally {
      const unchanged = this.resultVersions.get(jobId) === version;
      const committedVersion = this.invalidateResults(jobId);
      if (written && unchanged) {
        if (previous !== undefined) {
          previous.add(saved, writtenVersion);
          this.cacheResults(jobId, previous);
        } else {
          // A new job can build its cache as it writes its first result.
          const files = await this.resultFiles(jobId).catch(() => []);
          if (
            files.length === 1 &&
            files[0] === `${saved.gameId}.json` &&
            this.resultVersions.get(jobId) === committedVersion
          ) {
            this.cacheResults(
              jobId,
              new CachedResults([{ name, row: saved, version: writtenVersion }]),
            );
          }
        }
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
    return structuredClone(await this.resultRows(jobId));
  }

  public async resultPage(
    jobId: string,
    offset: number,
    limit: number,
    problemsOnly: boolean,
    status: CollectionHistoryRecord["job"]["status"],
  ): Promise<{ items: CollectionItemResult[]; total: number }> {
    safeId(jobId);
    const cached = this.cachedResults(jobId);
    if (cached !== undefined) {
      const rows = cached.ordered(problemsOnly);
      return { items: structuredClone(rows.slice(offset, offset + limit)), total: rows.length };
    }
    const version = this.resultVersions.get(jobId);
    const indexed = await this.indexedResultPage(jobId, offset, limit, problemsOnly).catch(
      (error) => {
        if (this.resultVersions.get(jobId) === version) throw error;
        return null;
      },
    );
    if (this.resultVersions.get(jobId) !== version)
      return this.resultPage(jobId, offset, limit, problemsOnly, status);
    if (indexed !== null) return indexed;

    const all = [...(await this.resultRows(jobId))].sort(compareHistoryResults);
    const loaded = this.resultCache.get(jobId);
    if (loaded !== undefined && resultHistoryIsFinal(status))
      await this.writeResultIndex(jobId, loaded, version);
    if (this.resultVersions.get(jobId) !== version)
      return this.resultPage(jobId, offset, limit, problemsOnly, status);
    const rows = problemsOnly ? all.filter(problemResult) : all;
    return { items: structuredClone(rows.slice(offset, offset + limit)), total: rows.length };
  }

  private async resultRows(jobId: string): Promise<CollectionItemResult[]> {
    safeId(jobId);
    const cached = this.cachedResults(jobId);
    if (cached !== undefined) return cached.byGameId();
    const version = this.resultVersions.get(jobId);
    let pending = this.resultReads.get(jobId);
    if (pending === undefined) {
      pending = this.readResults(jobId)
        .then((items) => {
          const rows = items.map(({ row }) => row);
          rows.sort((a, b) => compareCanonicalStrings(a.gameId, b.gameId));
          if (
            this.resultVersions.get(jobId) === version &&
            new Set(rows.map(({ gameId }) => gameId)).size === rows.length &&
            items.every(({ name, row }) => name === `${row.gameId}.json`)
          )
            this.cacheResults(jobId, new CachedResults(items));
          return rows;
        })
        .finally(() => {
          if (this.resultReads.get(jobId) === pending) this.resultReads.delete(jobId);
        });
      this.resultReads.set(jobId, pending);
    }
    try {
      const rows = await pending;
      return this.resultVersions.get(jobId) === version ? rows : this.resultRows(jobId);
    } catch (error: unknown) {
      if (this.resultVersions.get(jobId) !== version) return this.resultRows(jobId);
      throw error;
    }
  }

  private cachedResults(jobId: string): CachedResults | undefined {
    const cached = this.resultCache.get(jobId);
    if (cached !== undefined) {
      this.resultCache.delete(jobId);
      this.resultCache.set(jobId, cached);
    }
    return cached;
  }

  private async indexedResultPage(
    jobId: string,
    offset: number,
    limit: number,
    problemsOnly: boolean,
  ) {
    const indexed = await this.read(
      this.file("jobs", jobId, "result-index.json"),
      resultIndexSchema,
    ).catch(() => null);
    if (indexed === null) return null;
    const files = await this.resultFiles(jobId);
    const expected = new Set(indexed.map(({ gameId }) => `${gameId}.json`));
    if (
      indexed.length !== expected.size ||
      files.length !== expected.size ||
      files.some((file) => !expected.has(file))
    )
      return null;
    const current = await compactBatches(indexed, async (item) => {
      const filename = this.file("jobs", jobId, `items/${safeId(item.gameId)}.json`);
      return stat(filename, { bigint: true }).then(
        (value) => jsonFileVersion(value) === item.version,
        () => false,
      );
    });
    if (current.includes(false)) return null;
    const ordered = (problemsOnly ? indexed.filter(problemResult) : indexed).sort(
      compareHistoryResults,
    );
    const wanted = ordered.slice(offset, offset + limit);
    const items = await compactBatches(wanted, async (item) => {
      const row = await this.read(
        this.file("jobs", jobId, `items/${safeId(item.gameId)}.json`),
        CollectionItemResultSchema,
      );
      return row !== null &&
        row.gameId === item.gameId &&
        row.finishedAt === item.finishedAt &&
        row.outcome === item.outcome &&
        hash(row) === item.hash
        ? row
        : null;
    });
    return items.length === wanted.length ? { items, total: ordered.length } : null;
  }

  private writeResultIndex(
    jobId: string,
    results: CachedResults,
    version: number | undefined,
  ): Promise<void> {
    if (this.resultVersions.get(jobId) !== version) return Promise.resolve();
    const previous = this.resultIndexWrites.get(jobId);
    if (previous !== undefined && previous.version === version) return previous.promise;
    const promise = (previous?.promise ?? Promise.resolve())
      .then(async () => {
        if (this.resultVersions.get(jobId) !== version) return;
        const records = results.index();
        if (records === null) return;
        // A missing or incomplete index is rebuilt from the immutable result files.
        await this.write(this.file("jobs", jobId, "result-index.json"), resultIndexSchema, records);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.resultIndexWrites.get(jobId)?.promise === promise)
          this.resultIndexWrites.delete(jobId);
      });
    this.resultIndexWrites.set(jobId, { version, promise });
    return promise;
  }

  private async resultFiles(jobId: string): Promise<string[]> {
    return (await readDirectoryIfPresent(this.file("jobs", jobId, "items")))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort(compareCanonicalStrings);
  }

  private async readResults(jobId: string): Promise<VerifiedResultFile[]> {
    const directory = this.file("jobs", jobId, "items");
    const files = await this.resultFiles(jobId);
    return compactBatches(files, async (name) => {
      try {
        const handle = await open(path.join(directory, name), "r");
        try {
          const version = await handle
            .stat({ bigint: true })
            .then(jsonFileVersion, () => undefined);
          const row = decode(CollectionItemResultSchema, await handle.readFile("utf8"));
          const after = await handle.stat({ bigint: true }).then(jsonFileVersion, () => undefined);
          return { name, row, version: version === after ? version : undefined };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    });
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
  private cacheResults(jobId: string, rows: CachedResults): void {
    const { bytes } = rows;
    if (bytes > 32 * 1024 * 1024) return;
    const previous = this.resultCache.get(jobId);
    if (previous !== undefined) this.resultBytes -= previous.bytes;
    this.resultCache.delete(jobId);
    this.resultCache.set(jobId, rows);
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
    const payload = canonicalStringify(Value.Decode(schema, value));
    const checksum = createHash("sha256").update(payload).digest("hex");
    const encoded = `{"hash":"${checksum}","payload":${payload}}\n`;
    if (immutable) {
      const previous = await this.readBytes(filename);
      if (previous !== null) {
        if (previous.toString("utf8") === encoded) return;
        throw new Error("확정된 수집 대상 또는 경기 결과는 덮어쓸 수 없습니다.");
      }
    }
    await atomicWrite(this.root, filename, encoded);
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
async function compactBatches<K, T>(
  keys: readonly K[],
  read: (key: K) => Promise<T | null>,
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; offset < keys.length; offset += 16) {
    for (const record of await Promise.all(keys.slice(offset, offset + 16).map(read)))
      if (record !== null) result.push(record);
  }
  return result;
}
