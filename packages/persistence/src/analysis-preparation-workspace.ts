import { readFile } from "node:fs/promises";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisPreparationSchema,
  canonicalStringify,
  type AnalysisPreparation,
} from "@kbo/contracts";
import { atomicWrite, isMissing } from "./workspace-files.js";
import { assertSeason } from "./workspace-path-policy.js";

/** Only refresh status lives here; corrected ledgers and sealed revisions are never rewritten. */
export class AnalysisPreparationWorkspace {
  private readonly reads = new Map<number, Promise<AnalysisPreparation | null>>();

  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  private target(season: number) {
    assertSeason(season);
    return path.join(this.root, "analysis", "preparation", `${season}.json`);
  }
  public async read(season: number): Promise<AnalysisPreparation | null> {
    const pending = this.reads.get(season) ?? this.readStatusFile(season);
    this.reads.set(season, pending);
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (this.reads.get(season) === pending) this.reads.delete(season);
      throw error;
    }
  }
  private async readStatusFile(season: number): Promise<AnalysisPreparation | null> {
    try {
      const value = Value.Decode(
        AnalysisPreparationSchema,
        JSON.parse(await readFile(this.target(season), "utf8")),
      );
      if (value.season !== season) throw new Error("Analysis preparation season mismatch");
      return value;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  public async write(value: AnalysisPreparation) {
    const decoded = Value.Decode(AnalysisPreparationSchema, value);
    await this.assertWriter();
    try {
      await atomicWrite(this.root, this.target(decoded.season), canonicalStringify(decoded));
    } finally {
      // The workspace writer owns these files for its lifetime. After any
      // attempted replacement, read the durable file again on demand.
      this.reads.delete(decoded.season);
    }
  }
}
