import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalStringify,
  PitchReferenceEnvelopeSchema,
  PitchReferenceKeySchema,
  PitchReferenceSchema,
  type PitchReference,
  type PitchReferenceKey,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

import { atomicWrite, isMissing } from "./workspace-files.js";

export class PitchReferenceWorkspace {
  private readonly pending = new Map<string, Promise<PitchReference["reference"]>>();

  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}

  public async getOrCreate(
    key: PitchReferenceKey,
    calculate: () => Promise<PitchReference["reference"]>,
  ): Promise<PitchReference["reference"]> {
    if (!Value.Check(PitchReferenceKeySchema, key)) throw new Error("Invalid pitch reference key");
    const target = path.join(
      this.root,
      "analysis",
      "pitch-reference",
      `v${key.modelVersion}`,
      `reference-v${key.referenceVersion}`,
      key.calibrationHash ?? "source-plane",
      String(key.season),
      `${key.sourceHash}.json`,
    );
    let operation = this.pending.get(target);
    if (operation === undefined) {
      operation = this.loadOrCalculate(target, key, calculate);
      this.pending.set(target, operation);
    }
    try {
      // A response consumer must not mutate another request's shared baseline.
      return structuredClone(await operation);
    } finally {
      if (this.pending.get(target) === operation) this.pending.delete(target);
    }
  }

  private async loadOrCalculate(
    target: string,
    key: PitchReferenceKey,
    calculate: () => Promise<PitchReference["reference"]>,
  ): Promise<PitchReference["reference"]> {
    const cached = await this.read(target, key);
    if (cached !== undefined) return cached.reference;
    const payload: PitchReference = { ...key, reference: await calculate() };
    if (!Value.Check(PitchReferenceSchema, payload)) throw new Error("Invalid pitch reference");
    const envelope = { hash: contentHash(payload), payload };
    await this.assertWriter();
    await atomicWrite(target, `${canonicalStringify(envelope)}\n`);
    return payload.reference;
  }

  private async read(target: string, key: PitchReferenceKey): Promise<PitchReference | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(target, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (!Value.Check(PitchReferenceEnvelopeSchema, value)) return undefined;
    const { payload } = value;
    if (
      payload.modelVersion !== key.modelVersion ||
      payload.referenceVersion !== key.referenceVersion ||
      payload.season !== key.season ||
      payload.sourceHash !== key.sourceHash ||
      payload.calibrationHash !== key.calibrationHash
    )
      return undefined;
    try {
      if (value.hash !== contentHash(payload)) return undefined;
    } catch {
      // JSON numbers may decode but still violate the canonical finite/safe-number contract.
      return undefined;
    }
    return payload;
  }
}

function contentHash(payload: PitchReference): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}
