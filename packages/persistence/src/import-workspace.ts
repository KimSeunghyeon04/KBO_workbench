import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  canonicalStringify,
  compareCanonicalStrings,
  ImportJobRecordSchema,
  ImportJobSchema,
  ImportBatchRecordSchema,
  ImportSelectionRecordSchema,
  type ImportJobRecord,
  type ImportJob,
  type ImportBatchRecord,
  type ImportSelectionRecord,
} from "@kbo/contracts";
import { atomicWrite, isMissing, readDirectoryIfPresent } from "./workspace-files.js";

const envelopeSchema = Type.Object(
  { hash: Type.String(), payload: Type.Unknown() },
  { additionalProperties: false },
);

/** 한 writer가 소유하는 파일 workspace에 적재 의도와 결과를 경기별로 기록한다. */
export class ImportWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  public saveJob(record: ImportJobRecord): Promise<void> {
    return this.write("jobs", record.job.jobId, ImportJobRecordSchema, record);
  }
  public saveRetainedJob(job: ImportJob): Promise<void> {
    if (job.status === "queued" || job.status === "running")
      throw new Error("완료된 기존 적재 이력만 보존할 수 있습니다.");
    return this.write("retained", job.jobId, ImportJobSchema, job, true);
  }
  public retainedJobs(): Promise<ImportJob[]> {
    return this.list("retained", ImportJobSchema);
  }
  public saveBatch(record: ImportBatchRecord): Promise<void> {
    return this.write("batches", record.batch.batchId, ImportBatchRecordSchema, record, true);
  }
  public saveSelection(record: ImportSelectionRecord): Promise<void> {
    return this.write(
      "selections",
      record.selection.selectionId,
      ImportSelectionRecordSchema,
      record,
      true,
    );
  }
  public selection(id: string): Promise<ImportSelectionRecord | null> {
    return this.read("selections", id, ImportSelectionRecordSchema);
  }
  public jobs(): Promise<ImportJobRecord[]> {
    return this.list("jobs", ImportJobRecordSchema);
  }
  public batches(): Promise<ImportBatchRecord[]> {
    return this.list("batches", ImportBatchRecordSchema);
  }
  private file(kind: string, id: string): string {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("유효하지 않은 적재 기록 ID입니다.");
    return path.join(this.root, "imports", kind, `${id}.json`);
  }
  private async read<S extends TSchema>(
    kind: string,
    id: string,
    schema: S,
  ): Promise<Static<S> | null> {
    let text: string;
    try {
      text = await readFile(this.file(kind, id), "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return null;
      throw error;
    }
    const envelope = Value.Decode(envelopeSchema, JSON.parse(text) as unknown);
    if (hash(envelope.payload) !== envelope.hash)
      throw new Error("적재 기록 hash가 일치하지 않습니다.");
    return Value.Decode(schema, envelope.payload);
  }
  private async write<S extends TSchema>(
    kind: string,
    id: string,
    schema: S,
    value: unknown,
    immutable = false,
  ): Promise<void> {
    await this.assertWriter();
    const payload = Value.Decode(schema, value);
    if (immutable) {
      const previous = await this.read(kind, id, schema);
      if (previous !== null) {
        if (hash(previous) === hash(payload)) return;
        throw new Error("확정한 적재 대상은 변경할 수 없습니다.");
      }
    }
    await atomicWrite(
      this.file(kind, id),
      `${canonicalStringify({ hash: hash(payload), payload })}\n`,
    );
  }
  private async list<S extends TSchema>(kind: string, schema: S): Promise<Static<S>[]> {
    const entries = (await readDirectoryIfPresent(path.join(this.root, "imports", kind)))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .sort(compareCanonicalStrings);
    const result: Static<S>[] = [];
    for (let offset = 0; offset < entries.length; offset += 16) {
      const records = await Promise.allSettled(
        entries.slice(offset, offset + 16).map((id) => this.read(kind, id, schema)),
      );
      for (const record of records) {
        if (record.status === "rejected") throw record.reason;
        if (record.value !== null) result.push(record.value);
      }
    }
    return result;
  }
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}
