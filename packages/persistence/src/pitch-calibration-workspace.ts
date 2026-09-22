import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalStringify,
  PitchCalibrationEnvelopeSchema,
  PitchCalibrationKeySchema,
  PitchCalibrationSeasonSchema,
  type PitchCalibrationKey,
  type PitchCalibrationSeason,
} from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";
import { atomicWrite, isMissing } from "./workspace-files.js";
import { pitchCalibrationHash, validPitchCalibrationSeason } from "./pitch-calibration.js";

export class PitchCalibrationWorkspace {
  private readonly pending = new Map<string, Promise<PitchCalibrationSeason>>();
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}

  public async getOrCreate(
    key: PitchCalibrationKey,
    calculate: (previous: PitchCalibrationSeason | null) => Promise<PitchCalibrationSeason>,
  ): Promise<PitchCalibrationSeason> {
    if (!Value.Check(PitchCalibrationKeySchema, key)) throw new Error("Invalid calibration key");
    const directory = path.join(
      this.root,
      "analysis",
      "pitch-calibration",
      `v${key.modelVersion}`,
      String(key.season),
    );
    const target = path.join(directory, `${key.sourceHash}.json`);
    let operation = this.pending.get(target);
    if (operation === undefined) {
      operation = this.load(target, path.join(directory, "latest.json"), key, calculate);
      this.pending.set(target, operation);
    }
    try {
      return structuredClone(await operation);
    } finally {
      if (this.pending.get(target) === operation) this.pending.delete(target);
    }
  }

  private async load(
    target: string,
    latest: string,
    key: PitchCalibrationKey,
    calculate: (previous: PitchCalibrationSeason | null) => Promise<PitchCalibrationSeason>,
  ): Promise<PitchCalibrationSeason> {
    const cached = await this.read(target, key);
    if (cached?.sourceHash === key.sourceHash) return cached;
    const payload = await calculate(await this.read(latest, key));
    if (
      !Value.Check(PitchCalibrationSeasonSchema, payload) ||
      !validPitchCalibrationSeason(payload) ||
      payload.modelVersion !== key.modelVersion ||
      payload.season !== key.season ||
      payload.sourceHash !== key.sourceHash
    )
      throw new Error("Invalid calculated calibration profile");
    const serialized = `${canonicalStringify({ hash: pitchCalibrationHash(payload), payload })}\n`;
    await this.assertWriter();
    await atomicWrite(target, serialized);
    // Only a reuse hint. Every reused day is checked against its own past-input
    // hash, so concurrent snapshots cannot make an older hint authoritative.
    await atomicWrite(latest, serialized);
    return payload;
  }

  private async read(
    target: string,
    key: PitchCalibrationKey,
  ): Promise<PitchCalibrationSeason | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(target, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
    if (!Value.Check(PitchCalibrationEnvelopeSchema, value)) return null;
    const { payload } = value;
    if (payload.modelVersion !== key.modelVersion || payload.season !== key.season) return null;
    try {
      return value.hash === pitchCalibrationHash(payload) && validPitchCalibrationSeason(payload)
        ? payload
        : null;
    } catch {
      return null;
    }
  }
}
