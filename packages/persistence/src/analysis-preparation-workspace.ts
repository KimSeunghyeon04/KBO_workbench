import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AnalysisPreparationSchema,
  canonicalStringify,
  type AnalysisPreparation,
} from "@kbo/contracts";
import { atomicWrite, isMissing } from "./workspace-files.js";
import { assertSeason } from "./workspace-path-policy.js";

export const COMPETITION_CLASSIFICATION_POLICY_VERSION = 1;
const classificationSchema = Type.Object(
  {
    policyVersion: Type.Integer({ minimum: 1 }),
    season: AnalysisPreparationSchema.properties.season,
    sourceHash: AnalysisPreparationSchema.properties.sourceHash,
    competitionHash: AnalysisPreparationSchema.properties.competitionHash,
    completedAt: AnalysisPreparationSchema.properties.updatedAt,
    error: AnalysisPreparationSchema.properties.error,
  },
  { additionalProperties: false },
);
export type CompetitionClassificationCheckpoint = Static<typeof classificationSchema>;

/** Only refresh status lives here; corrected ledgers and sealed revisions are never rewritten. */
export class AnalysisPreparationWorkspace {
  private readonly reads = new Map<number, Promise<AnalysisPreparation | null>>();
  private readonly classificationReads = new Map<
    number,
    Promise<CompetitionClassificationCheckpoint | null>
  >();

  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}
  private target(season: number) {
    assertSeason(season);
    return path.join(this.root, "analysis", "preparation", `${season}.json`);
  }
  private classificationTarget(season: number) {
    assertSeason(season);
    return path.join(this.root, "analysis", "preparation", "classification", `${season}.json`);
  }

  public async readClassification(
    season: number,
  ): Promise<CompetitionClassificationCheckpoint | null> {
    return this.readCached(season, this.classificationReads, () =>
      this.readClassificationFile(season),
    );
  }

  private async readClassificationFile(
    season: number,
  ): Promise<CompetitionClassificationCheckpoint | null> {
    try {
      const value = Value.Decode(
        classificationSchema,
        JSON.parse(await readFile(this.classificationTarget(season), "utf8")),
      );
      if (value.season !== season) throw new Error("Competition classification season mismatch");
      return value;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  public async writeClassification(
    {
      season,
      sourceHash,
      competitionHash,
    }: Pick<AnalysisPreparation, "season" | "sourceHash" | "competitionHash">,
    completedAt: string,
    error: string | null = null,
  ) {
    const value = Value.Decode(classificationSchema, {
      policyVersion: COMPETITION_CLASSIFICATION_POLICY_VERSION,
      season,
      sourceHash,
      competitionHash,
      completedAt,
      error,
    });
    await this.assertWriter();
    try {
      await atomicWrite(this.root, this.classificationTarget(season), canonicalStringify(value));
    } finally {
      this.classificationReads.delete(season);
    }
  }
  public async read(season: number): Promise<AnalysisPreparation | null> {
    return this.readCached(season, this.reads, () => this.readStatusFile(season));
  }
  private async readCached<T>(
    season: number,
    reads: Map<number, Promise<T>>,
    load: () => Promise<T>,
  ): Promise<T> {
    const pending = reads.get(season) ?? load();
    reads.set(season, pending);
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (reads.get(season) === pending) reads.delete(season);
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
