import { open } from "node:fs/promises";
import path from "node:path";
import {
  AnalysisCompetitionSchema,
  AnalysisScopeQuerySchema,
  MAX_DISCIPLINE_CACHE_BYTES,
  type AnalysisScope,
} from "@kbo/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { atomicWrite, isMissing } from "./workspace-files.js";

export type DisciplineCacheScope = Pick<AnalysisScope, "season" | "competition">;

const scopeSchema = Type.Object({
  season: AnalysisScopeQuerySchema.properties.season,
  competition: AnalysisCompetitionSchema,
});

export class DisciplinePreparedWorkspace {
  public constructor(
    private readonly root: string,
    private readonly assertWriter: () => Promise<void>,
  ) {}

  public async read(scope: DisciplineCacheScope): Promise<Uint8Array | undefined> {
    try {
      const file = await open(this.target(scope), "r");
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_DISCIPLINE_CACHE_BYTES) return undefined;
        return await file.readFile();
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  public async write(scope: DisciplineCacheScope, artifact: Uint8Array): Promise<void> {
    if (artifact.byteLength > MAX_DISCIPLINE_CACHE_BYTES) return;
    await this.assertWriter();
    await atomicWrite(this.root, this.target(scope), artifact);
  }

  private target(scope: DisciplineCacheScope): string {
    if (!Value.Check(scopeSchema, scope)) throw new Error("Invalid discipline cache scope");
    return path.join(
      this.root,
      "analysis",
      "batter-discipline",
      `${scope.season}-${scope.competition}.bin`,
    );
  }
}
